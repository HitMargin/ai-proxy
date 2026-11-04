// probe2 — 原始 HTTP/1.1 over utls：完全控制头序，测 ESA 对 POST /messages 的拦截判据
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
	iv, err1 := base64.RawURLEncoding.DecodeString(parts[0])
	tag, err2 := base64.RawURLEncoding.DecodeString(parts[1])
	ct, err3 := base64.RawURLEncoding.DecodeString(parts[2])
	if err1 != nil || err2 != nil || err3 != nil || len(iv) != 12 || len(tag) != 16 {
		return "", fmt.Errorf("bad parts")
	}
	full := append(append([]byte{}, ct...), tag...)
	pt, err := gcm.Open(nil, iv, full, nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func loadZJWT() (string, error) {
	home, _ := os.UserHomeDir()
	raw, err := os.ReadFile(filepath.Join(home, ".zcode", "v2", "credentials.json"))
	if err != nil {
		return "", err
	}
	var store map[string]string
	if err := json.Unmarshal(raw, &store); err != nil {
		return "", err
	}
	return decryptZCode(store["zcodejwttoken"], zcodeSecret())
}

// 用 Go 原生 TLS GET 收 WAF cookie（不追求 200，只要 set-cookie）
func harvestCookies() map[string]string {
	client := &http.Client{Timeout: 30 * time.Second}
	req, _ := http.NewRequest("GET", "https://"+host+"/api/v1/zcode-plan/billing/current", nil)
	req.Header.Set("user-agent", "ZCode/3.17.2")
	req.Header.Set("x-zcode-app-version", "5.9.3")
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
	fmt.Printf("[harvest] HTTP %d cookies=%v\n", resp.StatusCode, keys(jar))
	return jar
}

func keys(m map[string]string) []string {
	out := []string{}
	for k := range m {
		out = append(out, k)
	}
	return out
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

// 发原始请求，读完整响应（connection: close 语义）
func rawRequest(conn net.Conn, request []byte) (int, map[string]string, []byte, error) {
	conn.SetDeadline(time.Now().Add(45 * time.Second))
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
	if strings.EqualFold(hdrs["content-encoding"], "gzip") {
		gz, err := gzip.NewReader(bytes.NewReader(body))
		if err == nil {
			body, _ = io.ReadAll(gz)
		}
	} else if n, err := strconv.Atoi(hdrs["content-length"]); err == nil && len(body) > n {
		body = body[:n]
	}
	return status, hdrs, body, nil
}

func buildRequest(method, path, headerBlock string, body []byte) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, "%s %s HTTP/1.1\r\n", method, path)
	fmt.Fprintf(&b, "host: %s\r\n", host)
	fmt.Fprint(&b, headerBlock)
	fmt.Fprintf(&b, "connection: close\r\n")
	fmt.Fprintf(&b, "content-length: %d\r\n\r\n", len(body))
	b.Write(body)
	return b.Bytes()
}

const messagesPath = "/api/v1/zcode-plan/anthropic/v1/messages"

func main() {
	zjwt, err := loadZJWT()
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

	body := []byte(`{"model":"glm-5.3-flash","max_tokens":16,"messages":[{"role":"user","content":"只回两个字：收到"}],"stream":false}`)

	common := []string{
		"x-zcode-app-version: 3.17.2",
		"x-title: Z Code@electron",
		"x-platform: win32-x64",
		"x-os-category: windows",
		"x-os-version: 10.0.26300",
		"x-client-language: zh-CN",
		"x-client-timezone: Asia/Shanghai",
		"x-device-mid: 0c5f8e58-4f22-45c3-a8dc-a507071cf840",
		"x-zcode-query-source: main_turn",
		"anthropic-version: 2023-06-01",
		"content-type: application/json",
		"accept: application/json, text/plain, */*",
		"user-agent: ZCode/3.17.2",
		"referer: https://zcode.z.ai",
		"accept-language: zh-CN,zh;q=0.9,en;q=0.8",
		"accept-encoding: gzip, deflate, br",
	}

	variants := []struct {
		label   string
		auth    string
		cookie  bool
		srcHead bool
	}{
		{"bearer+cookie+src", "authorization: Bearer " + zjwt, true, true},
		{"xapikey+cookie+src", "x-api-key: " + zjwt, true, true},
		{"bearer+nocookie", "authorization: Bearer " + zjwt, false, true},
	}

	for _, v := range variants {
		conn, err := dialChromeH1(context.Background())
		if err != nil {
			fmt.Printf("[%s] dial ERROR %v\n", v.label, err)
			continue
		}
		lines := []string{v.auth}
		lines = append(lines, common...)
		if v.cookie && cookie != "" {
			lines = append(lines, "cookie: "+cookie)
		}
		block := ""
		for _, ln := range lines {
			block += ln + "\r\n"
		}
		st, hdrs, respBody, err := rawRequest(conn, buildRequest("POST", messagesPath, block, body))
		conn.Close()
		if err != nil {
			fmt.Printf("[%s] ERROR %v\n", v.label, err)
			continue
		}
		fmt.Printf("[%s] HTTP %d server=%s via=%s\n", v.label, st, hdrs["server"], first(hdrs["via"]))
		fmt.Printf("[%s] body: %s\n", v.label, strings.TrimSpace(string(respBody))[:min(300, len(strings.TrimSpace(string(respBody))))])
		if st == 200 {
			fmt.Println("[SUCCESS]", v.label)
			break
		}
	}
}

func first(s string) string {
	if i := strings.Index(s, ","); i > 0 {
		return s[:i]
	}
	return s
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
