// h1exact — raw HTTP/1.1 + utls Chrome 指纹 + model-io 捕获的精确头序
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
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
	parts := strings.Split(strings.TrimPrefix(store["zcodejwttoken"], "enc:v1:"), ".")
	if len(parts) != 3 {
		return "", fmt.Errorf("bad format")
	}
	sum := sha256.Sum256([]byte(zcodeSecret()))
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

// model-io 捕获的精确头序（去掉伪头）
func headerList(zjwt, requestID string) [][2]string {
	return [][2]string{
		{"http-referer", "https://zcode.z.ai"},
		{"user-agent", "ZCode/3.17.2"},
		{"x-zcode-app-version", "3.17.2"},
		{"x-title", "Z Code@electron"},
		{"x-release-channel", "production"},
		{"x-client-language", "zh-CN"},
		{"x-client-timezone", "Asia/Shanghai"},
		{"x-zcode-agent", "glm"},
		{"x-platform", "win32-x64"},
		{"x-os-category", "windows"},
		{"x-os-version", "10.0.26300"},
		{"x-request-id", requestID},
		{"x-zcode-session-type", "main"},
		{"x-zcode-trace-id", "a457e5e0-238c-4c43-9b41-b4dc65f384e5"},
		{"x-query-id", "01a1a3e5-97a8-75ed-94c5-68d5b6d278bf"},
		{"x-zcode-query-source", "main_turn"},
		{"x-session-id", "0966faf8-3073-40f1-8541-c0d058032e6c"},
		{"content-type", "application/json"},
		{"anthropic-version", "2023-06-01"},
		{"accept", "text/event-stream"},
	}
}

func main() {
	zjwt, err := loadZJWT()
	if err != nil {
		fmt.Println("[token] ERROR", err)
		return
	}
	body := `{"model":"glm-5.3-flash","max_tokens":16,"stream":false,"messages":[{"role":"user","content":"只回两个字：收到"}]}`

	authVariants := []struct {
		label string
		hdr   [2]string
	}{
		{"xapikey", [2]string{"x-api-key", zjwt}},
		{"bearer", [2]string{"authorization", "Bearer " + zjwt}},
		{"noauth", [2]string{"x-noauth", "1"}},
	}

	for _, av := range authVariants {
		raw, err := net.DialTimeout("tcp", host+":443", 10*time.Second)
		if err != nil {
			fmt.Println("[dial] ERROR", err)
			return
		}
		uc := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: []string{"h2", "http/1.1"}}, utls.HelloChrome_133)
		if err := uc.Handshake(); err != nil {
			fmt.Println("[tls] ERROR", err)
			return
		}
		fmt.Println("[tls] ALPN:", uc.ConnectionState().NegotiatedProtocol)

		var b bytes.Buffer
		fmt.Fprintf(&b, "POST /api/v1/zcode-plan/anthropic/v1/messages HTTP/1.1\r\n")
		fmt.Fprintf(&b, "host: %s\r\n", host)
		fmt.Fprintf(&b, "connection: close\r\n")
		fmt.Fprintf(&b, "content-length: %d\r\n", len(body))
		for _, h := range headerList(zjwt, uuid.NewString()) {
			if av.label == "noauth" && h[0] == "x-noauth" {
				continue
			}
			if av.label == "noauth" && (h[0] == "x-api-key") {
				continue
			}
			fmt.Fprintf(&b, "%s: %s\r\n", h[0], h[1])
		}
		if av.label != "noauth" {
			// 认证头放在 accept 之后、与捕获序一致的位置：插到 anthropic-version 后
			// 简化：直接追加（已验证顺序差异对 401/405 无影响的场景下再细化）
			fmt.Fprintf(&b, "%s: %s\r\n", av.hdr[0], av.hdr[1])
		}
		fmt.Fprintf(&b, "\r\n")
		b.WriteString(body)
		uc.Write(b.Bytes())

		uc.SetReadDeadline(time.Now().Add(45 * time.Second))
		raw2, _ := io.ReadAll(uc)
		uc.Close()
		head := raw2
		var bodyPart []byte
		if i := bytes.Index(raw2, []byte("\r\n\r\n")); i >= 0 {
			head = raw2[:i]
			bodyPart = raw2[i+4:]
		}
		status := "???"
		if len(head) > 0 {
			status = strings.SplitN(string(head), "\r\n", 2)[0]
		}
		// gzip 解
		out := bodyPart
		if strings.Contains(string(head), "gzip") {
			if gz, err := gzip.NewReader(bytes.NewReader(bodyPart)); err == nil {
				d, _ := io.ReadAll(gz)
				out = d
			}
		}
		fmt.Printf("[%s] %s\n", av.label, status)
		fmt.Printf("[%s] body: %s\n", av.label, strings.TrimSpace(string(out))[:min(260, len(strings.TrimSpace(string(out))))])
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
