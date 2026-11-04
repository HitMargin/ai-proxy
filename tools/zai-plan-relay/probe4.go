// probe4 — Chrome_133 指纹 + h2 ALPN + 完整 attribution 头
package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
	"golang.org/x/net/http2"

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

func main() {
	zjwt, err := loadZJWT()
	if err != nil {
		fmt.Println("[token] ERROR", err)
		os.Exit(1)
	}

	tr := &http2.Transport{
		DialTLSContext: func(ctx context.Context, network, addr string, _ *tls.Config) (net.Conn, error) {
			raw, err := (&net.Dialer{Timeout: 15 * time.Second}).DialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			uc := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: []string{"h2", "http/1.1"}}, utls.HelloChrome_133)
			if err := uc.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, err
			}
			fmt.Println("[h2] ALPN:", uc.ConnectionState().NegotiatedProtocol)
			return uc, nil
		},
	}

	body := `{"model":"glm-5.3-flash","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"只回两个字：收到"}]}`
	for i, auth := range []string{"x-api-key: " + zjwt, "authorization: Bearer " + zjwt} {
		req, _ := http.NewRequest("POST", "https://"+host+"/api/v1/zcode-plan/anthropic/v1/messages", strings.NewReader(body))
		h := req.Header
		h.Set("content-type", "application/json")
		h.Set("anthropic-version", "2023-06-01")
		h.Set("accept", "text/event-stream")
		parts := strings.SplitN(auth, ": ", 2)
		h.Set(parts[0], parts[1])
		h.Set("user-agent", "ZCode/3.17.2")
		h.Set("x-zcode-app-version", "3.17.2")
		h.Set("x-title", "Z Code@electron")
		h.Set("x-platform", "win32-x64")
		h.Set("x-os-category", "windows")
		h.Set("x-os-version", "10.0.26300")
		h.Set("x-client-language", "zh-CN")
		h.Set("x-client-timezone", "Asia/Shanghai")
		h.Set("x-device-mid", "0c5f8e58-4f22-45c3-a8dc-a507071cf840")
		h.Set("x-request-id", uuid.NewString())
		h.Set("x-zcode-session-type", "main")
		h.Set("x-zcode-trace-id", uuid.NewString())
		h.Set("x-session-id", uuid.NewString())
		h.Set("x-query-id", uuid.NewString())
		h.Set("x-zcode-query-source", "main_turn")
		h.Set("referer", "https://zcode.z.ai")
		h.Set("accept-language", "zh-CN,zh;q=0.9,en;q=0.8")

		resp, err := tr.RoundTrip(req)
		if err != nil {
			fmt.Printf("[v%d] ERROR %v\n", i, err)
			continue
		}
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 300))
		resp.Body.Close()
		fmt.Printf("[v%d %s] HTTP %d server=%s\n", i, parts[0], resp.StatusCode, resp.Header.Get("Server"))
		fmt.Printf("[v%d] body: %s\n", i, strings.TrimSpace(string(b)))
		if resp.StatusCode == 200 {
			fmt.Println("[SUCCESS]", i)
			break
		}
	}
}
