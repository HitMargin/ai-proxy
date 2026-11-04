// h2replay — 全保真 h2 重放：utls Chrome 指纹 + 手工 HPACK（精确头序）
package main

import (
	"bufio"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
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
	"golang.org/x/net/http2/hpack"
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

// 按 Chromium 顺序的 h2 头（伪头在前）——顺序来自 model-io 真实捕获
func headerList(zjwt, requestID, sessionID string) [][2]string {
	return [][2]string{
		{":method", "POST"},
		{":scheme", "https"},
		{":authority", host},
		{":path", "/api/v1/zcode-plan/anthropic/v1/messages"},
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
		{"x-session-id", sessionID},
		{"content-type", "application/json"},
		{"anthropic-version", "2023-06-01"},
		{"accept", "text/event-stream"},
		{"x-api-key", zjwt},
	}
}

func frame(w io.Writer, typ byte, flags byte, streamID uint32, payload []byte) error {
	hdr := make([]byte, 9)
	binary.BigEndian.PutUint32(hdr[0:3], uint32(len(payload)))
	hdr[3] = typ
	hdr[4] = flags
	binary.BigEndian.PutUint32(hdr[5:9], streamID&0x7fffffff)
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func readFrame(r *bufio.Reader) (typ byte, flags byte, streamID uint32, payload []byte, err error) {
	hdr := make([]byte, 9)
	if _, err = io.ReadFull(r, hdr); err != nil {
		return
	}
	length := int(binary.BigEndian.Uint32(hdr[0:3])) & 0xffffff
	typ = hdr[3]
	flags = hdr[4]
	streamID = binary.BigEndian.Uint32(hdr[5:9]) & 0x7fffffff
	payload = make([]byte, length)
	if length > 0 {
		_, err = io.ReadFull(r, payload)
	}
	return
}

func main() {
	zjwt, err := loadZJWT()
	if err != nil {
		fmt.Println("[token] ERROR", err)
		return
	}
	viaProxy := len(os.Args) > 1 && os.Args[1] == "proxy"

	// 1) TCP（直连或经 CONNECT 代理）
	var raw net.Conn
	if viaProxy {
		raw, err = net.DialTimeout("tcp", "127.0.0.1:7897", 10*time.Second)
		if err != nil {
			fmt.Println("[proxy] dial ERROR", err)
			return
		}
		fmt.Fprintf(raw, "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n\r\n", host, host)
		br := bufio.NewReader(raw)
		status, _ := br.ReadString('\n')
		for {
			line, _ := br.ReadString('\n')
			if line == "\r\n" || line == "" {
				break
			}
		}
		fmt.Println("[proxy] CONNECT ->", strings.TrimSpace(status))
	} else {
		raw, err = net.DialTimeout("tcp", host+":443", 10*time.Second)
		if err != nil {
			fmt.Println("[direct] dial ERROR", err)
			return
		}
	}

	// 2) utls Chrome 指纹 + h2 ALPN
	uc := utls.UClient(raw, &utls.Config{ServerName: host, NextProtos: []string{"h2"}}, utls.HelloChrome_133)
	if err := uc.Handshake(); err != nil {
		fmt.Println("[tls] ERROR", err)
		return
	}
	fmt.Println("[tls] ALPN:", uc.ConnectionState().NegotiatedProtocol)

	// 3) h2 握手：preface + Chrome 风格 SETTINGS
	pre := []byte("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
	uc.Write(pre)
	settings := []byte{}
	app := func(id uint16, val uint32) {
		settings = append(settings, byte(id>>8), byte(id))
		v := make([]byte, 4)
		binary.BigEndian.PutUint32(v, val)
		settings = append(settings, v...)
	}
	app(0x1, 65536)  // HEADER_TABLE_SIZE
	app(0x2, 0)      // ENABLE_PUSH
	app(0x3, 1000)   // MAX_CONCURRENT_STREAMS
	app(0x4, 6291456) // INITIAL_WINDOW_SIZE
	app(0x5, 262144) // MAX_HEADER_LIST_SIZE
	frame(uc, 0x4, 0, 0, settings)
	// connection-level WINDOW_UPDATE (Chrome: +15663105)
	win := make([]byte, 4)
	binary.BigEndian.PutUint32(win, 15663105)
	frame(uc, 0x8, 0, 0, win)

	// 4) HEADERS：HPACK，按捕获顺序
	var hbuf bytes.Buffer
	enc := hpack.NewEncoder(&hbuf)
	for _, h := range headerList(zjwt,
		fmt.Sprintf("%08x-%04x-4%03x-8%03x-%012x", time.Now().UnixNano()&0xffffffff, os.Getpid()&0xffff, os.Getpid()&0xfff, os.Getpid()&0xfff, time.Now().UnixNano()&0xffffffffffff),
		"0966faf8-3073-40f1-8541-c0d058032e6c") {
		if err := enc.WriteField(hpack.HeaderField{Name: h[0], Value: h[1]}); err != nil {
			fmt.Println("[hpack] ERROR", err)
			return
		}
	}
	frame(uc, 0x1, 0x4 /*END_HEADERS*/, 1, hbuf.Bytes())

	// 5) stream WINDOW_UPDATE + DATA
	frame(uc, 0x8, 0, 1, win)
	body := `{"model":"glm-5.3-flash","max_tokens":16,"stream":false,"messages":[{"role":"user","content":"只回两个字：收到"}]}`
	frame(uc, 0x0, 0x1 /*END_STREAM*/, 1, []byte(body))

	// 6) 读响应帧
	r := bufio.NewReader(uc)
	uc.SetReadDeadline(time.Now().Add(45 * time.Second))
	hpackDec := hpack.NewDecoder(4096, func(hf hpack.HeaderField) {
		fmt.Println("  <h> ", hf.Name+":", hf.Value)
	})
	gotStatus := false
	for i := 0; i < 40; i++ {
		typ, flags, sid, payload, err := readFrame(r)
		if err != nil {
			fmt.Println("[read] end:", err)
			break
		}
		switch typ {
		case 0x4: // SETTINGS
			if flags&0x1 == 0 {
				frame(uc, 0x4, 0x1, 0, nil)
			}
		case 0x1: // HEADERS
			if sid == 1 {
				// 去掉可能的 padding/priority
				pl := payload
				if flags&0x8 != 0 && len(pl) > 0 { // PADDED
					pad := int(pl[0])
					pl = pl[1 : len(pl)-pad]
				}
				if flags&0x20 != 0 && len(pl) >= 5 { // PRIORITY
					pl = pl[5:]
				}
				hpackDec.Write(pl)
			}
		case 0x0: // DATA
			if sid == 1 {
				fmt.Println("  <d> ", string(payload[:min(300, len(payload))]))
			}
		case 0x3: // RST_STREAM
			fmt.Println("[rst] stream", sid, "code", binary.BigEndian.Uint32(payload[:4]))
			goto done
		case 0x7: // GOAWAY
			fmt.Println("[goaway]", string(payload))
			goto done
		}
		if sid == 1 && flags&0x1 != 0 && (typ == 0x0 || typ == 0x1) {
			gotStatus = true
			goto done
		}
	}
done:
	if gotStatus {
		fmt.Println("[result] got stream response")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
