// probe3 — 原始 h1 + 完整 attribution 头组（x-request-id/session-type/trace-id/session-id/query-id）
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"

	"github.com/google/uuid"
)

const host = "zcode.z.ai"

func zcodeSecret() string {
	home, _ := os.UserHomeDir()
	platform := "linux"
	switch runtime.GOOS {
	case "windows":
		platform = "win32"
	case "darwin":
		platform = "darwin"
	}
	user := os.Getenv("USERNAME")
	if user == "" {
		user = "unknown"
	}
	return fmt.Sprintf("zcode-credential-fallback:%s:%s:%s", platform, home, user)
}

func decryptZCode(v, secret string) (string, error) {
	const prefix = "enc:v1:"
	if !strings.HasPrefix(v, prefix) {
		return v, nil
	}
	parts := strings.Split(strings.TrimPrefix(v, prefix), ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("bad format")
	}
	sum := sha256.Sum256([]byte(secret))
	block, _ := aes.NewCipher(sum[:])
	gcm, _ := cipher.NewGCM(block)
	iv, e1 := base64.RawURLEncoding.DecodeString(parts[0])
	tag, e2 := base64.RawURLEncoding.DecodeString(parts[1])
	ct, e3 := base64.RawURLEncoding.DecodeString(parts[2])
	if e1 != nil || e2 != nil || e3 != nil || len(iv) != 12 || len(tag) != 16 {
		return "", fmt.Errorf("bad parts")
	}
	full := append(append([]byte{}, ct...), tag...)
	pt, err := gcm.Open(nil, iv, full, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func loadCred(keyName string) (string, error) {
	home, _ := os.UserHomeDir()
	raw, err := os.ReadFile(filepath.Join(home, ".zcode", "v2", "credentials.json"))
	if err != nil {
		return "", err
	}
	var store map[string]string
	if err := json.Unmarshal(raw, &store); err != nil {
		return "", err
	}
	return decryptZCode(store[keyName], zcodeSecret())
}

func harvestCookies() map[string]string {
	client := &http.Client{Timeout: 30 * time.Second}
	req, _ := http.NewRequest("GET", "https://"+host+"/api/v1/zcode-plan/billing/balance?app_version=3.17.2", nil)
	req.Header.Set("user-agent", "ZCode/3.17.2")
	req.Header.Set("x-zcode-app-version", "3.17.2")
	req.Header.Set("x-device-mid", "0c5f8e58-4f22-45c3-a8dc-a507071cf840")
	req.Header.Set("accept", "application/json, text/plain, */*")
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println("[harvest] ERROR", err)
		return nil
	}
	defer resp.Body.Close()
	jar := map[string]string{}
	for _, c := range resp.Cookies() {
		jar[c.Name] = c.Value
	}
	fmt.Printf("[harvest] HTTP %d cookies=%v\n", resp.StatusCode, len(jar))
	return jar
}

func dialChromeH1(ctx context.Context) (net.Conn, error) {
	raw, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, "tcp", host+":443")
	if err != nil {
		return nil, err
	}
	uc := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: []string{"http/1.1"}}, utls.HelloChrome_133)
	if err := uc.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return uc, nil
}

func rawRequest(conn net.Conn, request []byte) (int, map[string]string, []byte, error) {
	conn.SetDeadline(time.Now().Add(60 * time.Second))
	if _, err := conn.Write(request); err != nil {
		return 0, nil, nil, err
	}
	raw, err := io.ReadAll(conn)
	if err != nil && len(raw) == 0 {
		return 0, nil, nil, err
	}
	sep := bytes.Index(raw, []byte("\r\n\r\n"))
	if sep < 0 {
		return 0, nil, nil, fmt.Errorf("no header terminator, got %d bytes", len(raw))
	}
	head := string(raw[:sep])
	body := raw[sep+4:]
	lines := strings.Split(head, "\r\n")
	status := 0
	fmt.Sscanf(lines[0], "HTTP/1.1 %d", &status)
	hdrs := map[string]string{}
	for _, ln := range lines[1:] {
		if i := strings.IndexByte(ln, ':'); i > 0 {
			hdrs[strings.ToLower(strings.TrimSpace(ln[:i]))] = strings.TrimSpace(ln[i+1:])
		}
	}
	if strings.EqualFold(hdrs["transfer-encoding"], "chunked") {
		// 简易 dechunk
		var out []byte
		for {
			i := bytes.Index(body, []byte("\r\n"))
			if i < 0 {
				break
			}
			n, err := strconv.ParseInt(string(body[:i]), 16, 64)
			if err != nil || n == 0 {
				break
			}
			out = append(out, body[i+2:i+2+int(n)]...)
			body = body[i+2+int(n)+2:]
		}
		body = out
	}
	if strings.EqualFold(hdrs["content-encoding"], "gzip") {
		gz, err := gzip.NewReader(bytes.NewReader(body))
		if err == nil {
			body, _ = io.ReadAll(gz)
		}
	}
	return status, hdrs, body, nil
}

const messagesPath = "/api/v1/zcode-plan/anthropic/v1/messages"

func main() {
	zjwt, err := loadCred("zcodejwttoken")
	if err != nil {
		fmt.Println("[token] ERROR", err)
		os.Exit(1)
	}
	fmt.Println("[token] loaded len =", len(zjwt))
	jar := harvestCookies()
	cookie := ""
	for k, v := range jar {
		cookie += k + "=" + v + "; "
	}
	cookie = strings.TrimSuffix(cookie, "; ")

	body := []byte(`{"model":"glm-5.3-flash","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"只回两个字：收到"}]}`)

	requestID := uuid.NewString()
	traceID := uuid.NewString()
	sessionID := uuid.NewString()
	queryID := uuid.NewString()

	head := []string{
		"x-request-id: " + requestID,
		"x-zcode-session-type: main",
		"x-zcode-trace-id: " + traceID,
		"x-session-id: " + sessionID,
		"x-query-id: " + queryID,
		"x-zcode-query-source: main_turn",
		"anthropic-version: 2023-06-01",
		"content-type: application/json",
		"user-agent: ZCode/3.17.2",
		"x-zcode-app-version: 3.17.2",
		"x-title: Z Code@electron",
		"x-platform: win32-x64",
		"x-os-category: windows",
		"x-os-version: 10.0.26300",
		"x-client-language: zh-CN",
		"x-client-timezone: Asia/Shanghai",
		"x-device-mid: 0c5f8e58-4f22-45c3-a8dc-a507071cf840",
		"accept: text/event-stream",
		"referer: https://zcode.z.ai",
		"accept-language: zh-CN,zh;q=0.9,en;q=0.8",
		"accept-encoding: gzip, deflate, br",
	}
	if cookie != "" {
		head = append(head, "cookie: "+cookie)
	}

	variants := []string{
		"x-api-key: " + zjwt,
		"authorization: Bearer " + zjwt,
	}
	for i, auth := range variants {
		conn, err := dialChromeH1(context.Background())
		if err != nil {
			fmt.Printf("[v%d] dial ERROR %v\n", i, err)
			continue
		}
		block := auth + "\r\n"
		for _, ln := range head {
			block += ln + "\r\n"
		}
		var b bytes.Buffer
		fmt.Fprintf(&b, "POST %s HTTP/1.1\r\nhost: %s\r\n", messagesPath, host)
		b.WriteString(block)
		fmt.Fprintf(&b, "connection: close\r\ncontent-length: %d\r\n\r\n", len(body))
		b.Write(body)
		st, hdrs, respBody, err := rawRequest(conn, b.Bytes())
		conn.Close()
		if err != nil {
			fmt.Printf("[v%d] ERROR %v\n", i, err)
			continue
		}
		preview := string(respBody)
		if len(preview) > 300 {
			preview = preview[:300]
		}
		fmt.Printf("[v%d %s] HTTP %d server=%s\n", i, strings.SplitN(auth, ":", 2)[0], st, hdrs["server"])
		fmt.Printf("[v%d] body: %s\n", i, strings.TrimSpace(preview))
		if st == 200 {
			fmt.Println("[SUCCESS]", i)
			break
		}
	}
}
