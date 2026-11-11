package hub

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"
)

// Fixture TS tomoni (apps/companion/test/signature-fixture.test.ts) bilan umumiy: ikkala til bir xil baytlarni imzolaydi.
const fixturePath = "../../../../packages/contracts/fixtures/device-signature.json"

type signatureVector struct {
	Name              string `json:"name"`
	PrivateKeyPem     string `json:"privateKeyPem"`
	DeviceID          string `json:"deviceId"`
	Method            string `json:"method"`
	PathWithQuery     string `json:"pathWithQuery"`
	Timestamp         int64  `json:"timestamp"`
	BodyBase64        string `json:"bodyBase64"`
	ExpectedSignature string `json:"expectedSignature"`
}

func loadVectors(t *testing.T) []signatureVector {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(fixturePath))
	if err != nil {
		t.Fatalf("fixture o'qilmadi: %v", err)
	}
	var fixture struct {
		Vectors []signatureVector `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("fixture JSON noto'g'ri: %v", err)
	}
	return fixture.Vectors
}

// writeKeyPEM PEM matnini vaqtinchalik faylga yozadi (LoadKey fayl yo'li bilan ishlaydi).
func writeKeyPEM(t *testing.T, pemText string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "helper.key")
	if err := os.WriteFile(path, []byte(pemText), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func fixedClock(ms int64) func() time.Time {
	return func() time.Time { return time.UnixMilli(ms) }
}

func testKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func signTimestamp(t *testing.T, s *Signer) int64 {
	t.Helper()
	raw := s.Sign("GET", "/x", nil).Get("x-ns-timestamp")
	ts, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		t.Fatalf("x-ns-timestamp %q son emas: %v", raw, err)
	}
	return ts
}

func TestSignatureMatchesFixtures(t *testing.T) {
	vectors := loadVectors(t)
	if len(vectors) < 3 {
		t.Fatalf("fixture'da %d vektor bor, kamida 3 kerak", len(vectors))
	}
	for _, v := range vectors {
		t.Run(v.Name, func(t *testing.T) {
			key, err := LoadKey(writeKeyPEM(t, v.PrivateKeyPem))
			if err != nil {
				t.Fatalf("LoadKey: %v", err)
			}
			body, err := base64.StdEncoding.DecodeString(v.BodyBase64)
			if err != nil {
				t.Fatalf("bodyBase64: %v", err)
			}
			s := NewSigner(v.DeviceID, key, "helper", fixedClock(v.Timestamp))
			h := s.Sign(v.Method, v.PathWithQuery, body)
			if got := h.Get("x-ns-device-id"); got != v.DeviceID {
				t.Errorf("x-ns-device-id = %q, want %q", got, v.DeviceID)
			}
			if got := h.Get("x-ns-timestamp"); got != strconv.FormatInt(v.Timestamp, 10) {
				t.Errorf("x-ns-timestamp = %q, want %d", got, v.Timestamp)
			}
			if got := h.Get("x-ns-signature"); got != v.ExpectedSignature {
				t.Errorf("x-ns-signature = %q, want %q", got, v.ExpectedSignature)
			}
			// Imzo canonical qatorni qamrab oladi, signer sarlavhasini emas.
			if got := h.Get("x-ns-signer"); got != "helper" {
				t.Errorf("x-ns-signer = %q, want helper", got)
			}
		})
	}
}

func TestSignerHeaderDoesNotChangeSignature(t *testing.T) {
	key := testKey(t)
	a := NewSigner("d", key, "helper", fixedClock(1_000)).Sign("GET", "/x", nil)
	b := NewSigner("d", key, "companion", fixedClock(1_000)).Sign("GET", "/x", nil)
	if a.Get("x-ns-signature") != b.Get("x-ns-signature") {
		t.Fatal("signer qiymati imzoga ta'sir qildi")
	}
	if a.Get("x-ns-signer") != "helper" || b.Get("x-ns-signer") != "companion" {
		t.Fatalf("x-ns-signer noto'g'ri: %q, %q", a.Get("x-ns-signer"), b.Get("x-ns-signer"))
	}
}

func TestTimestampStrictlyIncreases(t *testing.T) {
	s := NewSigner("d", testKey(t), "helper", fixedClock(1_000))
	first := signTimestamp(t, s)
	second := signTimestamp(t, s)
	third := signTimestamp(t, s)
	if first != 1_000 || second != first+1 || third != second+1 {
		t.Fatalf("timestamp'lar = %d, %d, %d; want 1000, 1001, 1002", first, second, third)
	}
}

func TestTimestampFollowsClockWhenItMovesForward(t *testing.T) {
	now := int64(1_000)
	s := NewSigner("d", testKey(t), "helper", func() time.Time { return time.UnixMilli(now) })
	if got := signTimestamp(t, s); got != 1_000 {
		t.Fatalf("ts = %d, want 1000", got)
	}
	now = 5_000
	if got := signTimestamp(t, s); got != 5_000 {
		t.Fatalf("ts = %d, want 5000", got)
	}
}

func TestSyncClockFixesOffsetAndPullsLastTimestamp(t *testing.T) {
	t.Run("adopts hub time only when skew exceeds five seconds", func(t *testing.T) {
		now := time.UnixMilli(1_000_000)
		s := NewSigner("d", testKey(t), "helper", func() time.Time { return now })
		s.SyncClock(now.Add(120 * time.Second))
		if got := signTimestamp(t, s); got != 1_120_000 {
			t.Fatalf("ts = %d, want 1120000", got)
		}
		// Soat to'g'rilangach (farq <= 5 s) eski offset qolmaydi.
		s.SyncClock(now.Add(4 * time.Second))
		if got := signTimestamp(t, s); got != 1_000_000 {
			t.Fatalf("ts = %d, want 1000000", got)
		}
		fresh := NewSigner("d", testKey(t), "helper", func() time.Time { return now })
		fresh.SyncClock(now.Add(-60 * time.Second))
		if got := signTimestamp(t, fresh); got != 940_000 {
			t.Fatalf("ts = %d, want 940000", got)
		}
	})

	t.Run("tolerance boundary is exactly five seconds", func(t *testing.T) {
		now := time.UnixMilli(1_000_000)
		s := NewSigner("d", testKey(t), "helper", func() time.Time { return now })
		s.SyncClock(now.Add(5 * time.Second))
		if got := signTimestamp(t, s); got != 1_000_000 {
			t.Fatalf("5 s farqda offset qo'llandi: ts = %d", got)
		}
		s.SyncClock(now.Add(-5 * time.Second))
		if got := signTimestamp(t, s); got != 1_000_001 {
			t.Fatalf("-5 s farqda offset qo'llandi: ts = %d", got)
		}
		s.SyncClock(now.Add(5*time.Second + time.Millisecond))
		if got := signTimestamp(t, s); got != 1_005_001 {
			t.Fatalf("5.001 s farqda offset qo'llanmadi: ts = %d, want 1005001", got)
		}
	})

	t.Run("a fast device clock recovers into the hub window", func(t *testing.T) {
		// Qurilma soati 2 daqiqa oldinda: birinchi imzo hub oynasidan tashqarida.
		now := time.UnixMilli(1_000_000 + 120_000)
		s := NewSigner("d", testKey(t), "helper", func() time.Time { return now })
		if got := signTimestamp(t, s); got != 1_120_000 {
			t.Fatalf("ts = %d, want 1120000", got)
		}
		s.SyncClock(time.UnixMilli(1_000_000))
		// Hub bu kelajakdagi qiymatni qabul qilmagan, shuning uchun keyingisi hub vaqtiga qaytadi.
		if got := signTimestamp(t, s); got != 1_000_000 {
			t.Fatalf("ts = %d, want 1000000", got)
		}
		if got := signTimestamp(t, s); got != 1_000_001 {
			t.Fatalf("ts = %d, want 1000001", got)
		}
	})

	t.Run("unchanged offset keeps last timestamp", func(t *testing.T) {
		now := time.UnixMilli(1_000)
		s := NewSigner("d", testKey(t), "helper", func() time.Time { return now })
		signTimestamp(t, s)
		signTimestamp(t, s) // last = 1001
		s.SyncClock(now)    // offset 0 -> 0: last tegilmaydi
		if got := signTimestamp(t, s); got != 1_002 {
			t.Fatalf("ts = %d, want 1002", got)
		}
	})
}

func TestSignIsSafeForConcurrentUse(t *testing.T) {
	s := NewSigner("d", testKey(t), "helper", fixedClock(1_000))
	const workers, perWorker = 8, 50
	var (
		mu   sync.Mutex
		seen = map[int64]bool{}
		wg   sync.WaitGroup
	)
	for range workers {
		wg.Go(func() {
			for range perWorker {
				ts := signTimestamp(t, s)
				mu.Lock()
				if seen[ts] {
					t.Errorf("timestamp %d takrorlandi", ts)
				}
				seen[ts] = true
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if len(seen) != workers*perWorker {
		t.Fatalf("%d ta noyob timestamp, want %d", len(seen), workers*perWorker)
	}
}

func TestLoadKey(t *testing.T) {
	t.Run("missing file", func(t *testing.T) {
		if _, err := LoadKey(filepath.Join(t.TempDir(), "nope.key")); err == nil {
			t.Fatal("yo'q fayl uchun xato kutilgan edi")
		}
	})
	t.Run("not PEM", func(t *testing.T) {
		if _, err := LoadKey(writeKeyPEM(t, "this is not a pem")); err == nil {
			t.Fatal("PEM bo'lmagan matn uchun xato kutilgan edi")
		}
	})
	t.Run("PEM block is not a private key", func(t *testing.T) {
		pub, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		der, err := x509.MarshalPKIXPublicKey(pub)
		if err != nil {
			t.Fatal(err)
		}
		text := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
		if _, err := LoadKey(writeKeyPEM(t, text)); err == nil {
			t.Fatal("public kalit PEM'i uchun xato kutilgan edi")
		}
	})
	t.Run("PKCS#8 key is not Ed25519", func(t *testing.T) {
		ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		der, err := x509.MarshalPKCS8PrivateKey(ec)
		if err != nil {
			t.Fatal(err)
		}
		text := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
		if _, err := LoadKey(writeKeyPEM(t, text)); err == nil {
			t.Fatal("ECDSA kalit uchun xato kutilgan edi")
		}
	})
	t.Run("round trip of a generated Ed25519 key", func(t *testing.T) {
		want := testKey(t)
		der, err := x509.MarshalPKCS8PrivateKey(want)
		if err != nil {
			t.Fatal(err)
		}
		got, err := LoadKey(writeKeyPEM(t, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))))
		if err != nil {
			t.Fatal(err)
		}
		if !got.Equal(want) {
			t.Fatal("o'qilgan kalit asl kalitga teng emas")
		}
	})
}
