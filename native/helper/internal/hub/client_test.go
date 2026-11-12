package hub

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- test PKI ---

var pkiCounter atomic.Int64

// testPKI: bitta CA va u imzolagan server sertifikati.
type testPKI struct {
	caPEM []byte
	leaf  tls.Certificate
}

// newPKI hub CA'sini va uning imzolagan server sertifikatini yaratadi. SAN'lar tekshiruv uchun tanlanadi.
func newPKI(t *testing.T, dnsNames []string, ips []net.IP) testPKI {
	t.Helper()
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	caTmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "test hub CA " + strconv.FormatInt(pkiCounter.Add(1), 10)},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTmpl, caTmpl, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(caDER)
	if err != nil {
		t.Fatal(err)
	}

	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "hub"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     dnsNames,
		IPAddresses:  ips,
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, caCert, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return testPKI{
		caPEM: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}),
		leaf:  tls.Certificate{Certificate: [][]byte{leafDER}, PrivateKey: leafKey},
	}
}

func loopbackPKI(t *testing.T) testPKI {
	t.Helper()
	return newPKI(t, []string{"localhost"}, []net.IP{net.ParseIP("127.0.0.1"), net.IPv6loopback})
}

func startHub(t *testing.T, pki testPKI, handler http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewUnstartedServer(handler)
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{pki.leaf}, MinVersion: tls.VersionTLS12}
	// Ishonchsiz mijozning handshake xatolari test chiqishini to'ldirmasin.
	srv.Config.ErrorLog = log.New(io.Discard, "", 0)
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

func newTestClient(t *testing.T, srv *httptest.Server, caPEM []byte, signer *Signer) *Client {
	t.Helper()
	c, err := NewClient(srv.URL, caPEM, signer)
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c.retryDelay = 0
	t.Cleanup(c.Close)
	return c
}

func helperSigner(t *testing.T, now func() time.Time) (*Signer, ed25519.PrivateKey) {
	t.Helper()
	key := testKey(t)
	return NewSigner("device-1", key, "helper", now), key
}

const okLockState = `{"locked":true,"sequence":"7","leaseSeconds":120}`

// --- TLS ---

func TestClientTrustsOnlyHubCA(t *testing.T) {
	hubPKI := loopbackPKI(t)
	otherPKI := loopbackPKI(t)
	var served atomic.Int32
	srv := startHub(t, hubPKI, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served.Add(1)
		io.WriteString(w, okLockState)
	}))
	signer, _ := helperSigner(t, time.Now)

	t.Run("hub CA is trusted", func(t *testing.T) {
		got, err := newTestClient(t, srv, hubPKI.caPEM, signer).LockState(context.Background())
		if err != nil {
			t.Fatalf("hub CA bilan so'rov xato: %v", err)
		}
		if !got.Locked || got.Sequence == nil || *got.Sequence != "7" || got.LeaseSeconds != 120 {
			t.Fatalf("LockState = %+v", got)
		}
	})

	before := served.Load()

	t.Run("another CA is rejected", func(t *testing.T) {
		_, err := newTestClient(t, srv, otherPKI.caPEM, signer).LockState(context.Background())
		var unknown x509.UnknownAuthorityError
		if !errors.As(err, &unknown) {
			t.Fatalf("boshqa CA bilan xato = %v, want x509.UnknownAuthorityError", err)
		}
	})

	t.Run("system roots do not trust the hub CA", func(t *testing.T) {
		// caPEM bo'sh: tizim root'lari. Test CA'si ularda yo'q.
		_, err := newTestClient(t, srv, nil, signer).LockState(context.Background())
		if err == nil {
			t.Fatal("tizim root'lari bilan test CA'si qabul qilindi")
		}
		var certErr *tls.CertificateVerificationError
		if !errors.As(err, &certErr) {
			t.Fatalf("xato = %v, want tls.CertificateVerificationError", err)
		}
	})

	if served.Load() != before {
		t.Fatal("ishonchsiz serverga so'rov (imzo sarlavhalari) yetib bordi")
	}
}

func TestClientChecksHostname(t *testing.T) {
	// CA ishonchli, lekin sertifikat 127.0.0.1 uchun emas.
	pki := newPKI(t, []string{"hub.example.test"}, nil)
	var served atomic.Int32
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		served.Add(1)
		io.WriteString(w, okLockState)
	}))
	signer, _ := helperSigner(t, time.Now)
	_, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background())
	var hostErr x509.HostnameError
	if !errors.As(err, &hostErr) {
		t.Fatalf("hostname mos kelmaganda xato = %v, want x509.HostnameError", err)
	}
	if served.Load() != 0 {
		t.Fatal("hostname mos kelmagan serverga so'rov yetib bordi")
	}
}

func TestNewClientRejectsBadInput(t *testing.T) {
	signer, _ := helperSigner(t, time.Now)
	pki := loopbackPKI(t)
	for name, tc := range map[string]struct {
		origin string
		ca     []byte
		signer *Signer
	}{
		"http origin":       {"http://hub.example", nil, signer},
		"origin with path":  {"https://hub.example/api", nil, signer},
		"origin with slash": {"https://hub.example/", nil, signer},
		"origin with query": {"https://hub.example?x=1", nil, signer},
		"origin userinfo":   {"https://user:pw@hub.example", nil, signer},
		"empty origin":      {"", nil, signer},
		"no host":           {"https://", nil, signer},
		"garbage CA":        {"https://hub.example", []byte("not a pem"), signer},
		"PEM without certs": {"https://hub.example", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte{1, 2, 3}}), signer},
		"nil signer":        {"https://hub.example", pki.caPEM, nil},
	} {
		if c, err := NewClient(tc.origin, tc.ca, tc.signer); err == nil {
			c.Close()
			t.Errorf("%s: NewClient xato bermadi", name)
		}
	}
	for _, ok := range []string{"https://hub.example", "https://hub.example:8443", "https://127.0.0.1:8443", "https://[::1]:8443"} {
		c, err := NewClient(ok, pki.caPEM, signer)
		if err != nil {
			t.Errorf("%q rad etildi: %v", ok, err)
			continue
		}
		c.Close()
	}
}

// TLS tekshiruvini o'chiradigan sozlama helper kodining hech bir faylida bo'lmasligi kerak (shu test fayli ham).
// Kalit so'z bo'laklarga bo'lib yozilgan, test o'zini topib yiqilmasin; faqat shu test e'lonining qatori
// (nomida kalit so'z bor) istisno.
func TestNoInsecureSkipVerifyInSource(t *testing.T) {
	needle := "Insecure" + "Skip" + "Verify"
	ownDecl := "func TestNo" + needle + "InSource("
	root := filepath.Join("..", "..") // native/helper: butun helper kodi
	scanned := 0
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		scanned++
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for i, line := range strings.Split(string(raw), "\n") {
			if strings.Contains(line, needle) && !strings.HasPrefix(line, ownDecl) {
				t.Errorf("%s:%d TLS tekshiruvini o'chiradigan sozlama bor", path, i+1)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 4 {
		t.Fatalf("faqat %d ta .go fayl tekshirildi: yo'l noto'g'ri bo'lishi mumkin", scanned)
	}
}

// --- so'rovlar ---

func TestLockStateRequestIsSignedAndDecoded(t *testing.T) {
	pki := loopbackPKI(t)
	signer, key := helperSigner(t, time.Now)
	var got struct {
		method, uri, contentType string
		headers                  http.Header
		body                     []byte
	}
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.method, got.uri, got.contentType = r.Method, r.URL.RequestURI(), r.Header.Get("Content-Type")
		got.headers = r.Header.Clone()
		got.body, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, `{"locked":false,"sequence":null,"leaseSeconds":120,"future":"field"}`)
	}))
	state, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if state.Locked || state.Sequence != nil || state.LeaseSeconds != 120 {
		t.Fatalf("LockState = %+v, want {false nil 120}", state)
	}
	if got.method != "GET" || got.uri != "/api/v1/device/helper/lock-state" || len(got.body) != 0 {
		t.Fatalf("so'rov = %s %s body=%q", got.method, got.uri, got.body)
	}
	if got.headers.Get("x-ns-device-id") != "device-1" || got.headers.Get("x-ns-signer") != "helper" {
		t.Fatalf("sarlavhalar = %v", got.headers)
	}
	verifySignature(t, key, got.method, got.uri, got.headers, got.body)
}

func TestReportStatusSendsExactJSONFieldNames(t *testing.T) {
	pki := loopbackPKI(t)
	signer, key := helperSigner(t, time.Now)
	var gotBody []byte
	var gotHeaders http.Header
	var gotMethod, gotURI string
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotMethod, gotURI, gotHeaders = r.Method, r.URL.RequestURI(), r.Header.Clone()
		gotBody, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusNoContent)
	}))
	status := Status{
		Version:      "0.1.0",
		Hook:         ComponentActive,
		Policy:       ComponentOff,
		ProcessGuard: ComponentFailed,
		CAD:          CADUnavailable,
		Companion:    CompanionNoSession,
		MeshAgent:    MeshAgentRestarted,
	}
	if err := newTestClient(t, srv, pki.caPEM, signer).ReportStatus(context.Background(), status); err != nil {
		t.Fatal(err)
	}
	if gotMethod != "PUT" || gotURI != "/api/v1/device/helper/status" {
		t.Fatalf("so'rov = %s %s", gotMethod, gotURI)
	}
	if gotHeaders.Get("Content-Type") != "application/json" {
		t.Fatalf("Content-Type = %q", gotHeaders.Get("Content-Type"))
	}
	var decoded map[string]string
	if err := json.Unmarshal(gotBody, &decoded); err != nil {
		t.Fatalf("tana JSON emas: %v (%s)", err, gotBody)
	}
	want := map[string]string{
		"version": "0.1.0", "hook": "active", "policy": "off", "processGuard": "failed",
		"cad": "unavailable", "companion": "no_session", "meshAgent": "restarted",
	}
	if len(decoded) != len(want) {
		t.Fatalf("tana maydonlari = %v, want %v", decoded, want)
	}
	for k, v := range want {
		if decoded[k] != v {
			t.Errorf("%s = %q, want %q", k, decoded[k], v)
		}
	}
	// Imzo aynan yuborilgan tana baytlarini qamrab oladi.
	verifySignature(t, key, gotMethod, gotURI, gotHeaders, gotBody)
}

// verifySignature hub'dagi tekshiruvni takrorlaydi: Ed25519 imzo canonical qator ustida.
func verifySignature(t *testing.T, key ed25519.PrivateKey, method, uri string, h http.Header, body []byte) {
	t.Helper()
	sig, err := base64.RawURLEncoding.DecodeString(h.Get("x-ns-signature"))
	if err != nil {
		t.Fatalf("x-ns-signature base64url emas: %v", err)
	}
	input := signingInput(method, uri, h.Get("x-ns-timestamp"), body)
	if !ed25519.Verify(key.Public().(ed25519.PublicKey), input, sig) {
		t.Fatal("imzo tekshiruvdan o'tmadi")
	}
}

func TestClientRetriesOnceAfterClockSync(t *testing.T) {
	pki := loopbackPKI(t)
	deviceNow := time.UnixMilli(1_800_000_000_000)
	hubNow := deviceNow.Add(time.Hour) // qurilma soati bir soat orqada
	signer, _ := helperSigner(t, func() time.Time { return deviceNow })

	var timestamps []string
	var mu sync.Mutex
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		timestamps = append(timestamps, r.Header.Get("x-ns-timestamp"))
		n := len(timestamps)
		mu.Unlock()
		w.Header().Set("Date", hubNow.UTC().Format(http.TimeFormat))
		if n == 1 {
			w.WriteHeader(http.StatusUnauthorized)
			io.WriteString(w, `{"error":{"code":"device_signature_invalid","message":"stale timestamp"}}`)
			return
		}
		io.WriteString(w, okLockState)
	}))
	state, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background())
	if err != nil {
		t.Fatalf("qayta urinishdan keyin ham xato: %v", err)
	}
	if !state.Locked {
		t.Fatalf("LockState = %+v", state)
	}
	if len(timestamps) != 2 {
		t.Fatalf("hub %d marta chaqirildi, want 2", len(timestamps))
	}
	if timestamps[0] != strconv.FormatInt(deviceNow.UnixMilli(), 10) {
		t.Errorf("birinchi timestamp = %s, want qurilma soati %d", timestamps[0], deviceNow.UnixMilli())
	}
	if timestamps[1] != strconv.FormatInt(hubNow.UnixMilli(), 10) {
		t.Errorf("ikkinchi timestamp = %s, want hub `Date` soati %d", timestamps[1], hubNow.UnixMilli())
	}
}

func TestClientRetriesOnlyOnce(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)
	for name, date := range map[string]string{"with Date": time.Now().UTC().Format(http.TimeFormat), "garbage Date": "yesterday-ish"} {
		t.Run(name, func(t *testing.T) {
			var calls atomic.Int32
			srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Date", date)
				w.WriteHeader(http.StatusUnauthorized)
				io.WriteString(w, `{"error":{"code":"device_signature_invalid","message":"nope"}}`)
			}))
			_, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background())
			var statusErr *StatusError
			if !errors.As(err, &statusErr) || statusErr.Status != 401 || statusErr.Code != "device_signature_invalid" {
				t.Fatalf("xato = %v, want 401 device_signature_invalid", err)
			}
			if calls.Load() != 2 {
				t.Fatalf("hub %d marta chaqirildi, want 2 (asl + bir marta qayta)", calls.Load())
			}
		})
	}
}

func TestClientDoesNotRetryOtherStatuses(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)
	for _, status := range []int{400, 403, 404, 500, 503} {
		var calls atomic.Int32
		srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.WriteHeader(status)
		}))
		_, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background())
		var statusErr *StatusError
		if !errors.As(err, &statusErr) || statusErr.Status != status {
			t.Errorf("%d: xato = %v", status, err)
		}
		if calls.Load() != 1 {
			t.Errorf("%d: hub %d marta chaqirildi, want 1", status, calls.Load())
		}
	}
}

func TestClientDoesNotFollowRedirects(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)
	var elsewhere atomic.Int32
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			elsewhere.Add(1)
			return
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	_, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background())
	var statusErr *StatusError
	if !errors.As(err, &statusErr) || statusErr.Status != http.StatusFound {
		t.Fatalf("xato = %v, want 302 StatusError", err)
	}
	if elsewhere.Load() != 0 {
		t.Fatal("imzolangan so'rov redirect orqali boshqa manzilga yuborildi")
	}
}

func TestLockStateRejectsUnusableBodies(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)
	for name, body := range map[string]string{
		"zero lease":     `{"locked":true,"sequence":"1","leaseSeconds":0}`,
		"negative lease": `{"locked":true,"sequence":"1","leaseSeconds":-5}`,
		"missing lease":  `{"locked":true,"sequence":"1"}`,
		"not json":       `<html>`,
		"empty":          ``,
		"wrong type":     `{"locked":"yes","sequence":"1","leaseSeconds":120}`,
		"numeric seq":    `{"locked":true,"sequence":1,"leaseSeconds":120}`,
		"too large":      `{"locked":false,"sequence":null,"leaseSeconds":120,"pad":"` + strings.Repeat("x", 3<<20) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
			if state, err := newTestClient(t, srv, pki.caPEM, signer).LockState(context.Background()); err == nil {
				t.Fatalf("yaroqsiz javob qabul qilindi: %+v", state)
			}
		})
	}
}

func TestReportStatusSurfacesHubError(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		io.WriteString(w, `{"error":{"code":"validation_failed","message":"hook: invalid"}}`)
	}))
	err := newTestClient(t, srv, pki.caPEM, signer).ReportStatus(context.Background(), Status{Version: "x"})
	var statusErr *StatusError
	if !errors.As(err, &statusErr) || statusErr.Status != 400 || statusErr.Code != "validation_failed" || statusErr.Message != "hook: invalid" {
		t.Fatalf("xato = %#v", err)
	}
}

// --- ketma-ketlik ---

// Task 1 review: parallel Sign chaqiruvlari hub'ga tartibsiz yetib borsa, kichik timestamp rad etiladi.
// Client bir vaqtda bitta imzolangan so'rovni yuboradi.
func TestRequestsAreSerialized(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)

	var inFlight, maxInFlight atomic.Int32
	var mu sync.Mutex
	var arrival []int64
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			prev := maxInFlight.Load()
			if n <= prev || maxInFlight.CompareAndSwap(prev, n) {
				break
			}
		}
		ts, _ := strconv.ParseInt(r.Header.Get("x-ns-timestamp"), 10, 64)
		mu.Lock()
		arrival = append(arrival, ts)
		mu.Unlock()
		time.Sleep(5 * time.Millisecond)
		io.WriteString(w, okLockState)
	}))
	c := newTestClient(t, srv, pki.caPEM, signer)

	const calls = 12
	var wg sync.WaitGroup
	errs := make(chan error, calls)
	for i := range calls {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if i%2 == 0 {
				_, err := c.LockState(context.Background())
				errs <- err
			} else {
				errs <- c.ReportStatus(context.Background(), Status{Version: "x"})
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if maxInFlight.Load() != 1 {
		t.Fatalf("bir vaqtda %d ta so'rov uchib yurdi, want 1", maxInFlight.Load())
	}
	if len(arrival) != calls {
		t.Fatalf("hub %d so'rov oldi, want %d", len(arrival), calls)
	}
	for i := 1; i < len(arrival); i++ {
		if arrival[i] <= arrival[i-1] {
			t.Fatalf("hub'ga timestamp'lar tartibsiz yetdi: %v", arrival)
		}
	}
}

func TestWaitingForTurnHonoursContext(t *testing.T) {
	pki := loopbackPKI(t)
	signer, _ := helperSigner(t, time.Now)
	release := make(chan struct{})
	started := make(chan struct{})
	var once sync.Once
	srv := startHub(t, pki, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(started) })
		<-release
		io.WriteString(w, okLockState)
	}))
	c := newTestClient(t, srv, pki.caPEM, signer)

	first := make(chan error, 1)
	go func() {
		_, err := c.LockState(context.Background())
		first <- err
	}()
	<-started

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	begin := time.Now()
	_, err := c.LockState(ctx)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("navbat kutayotgan so'rov xatosi = %v, want context.DeadlineExceeded", err)
	}
	if time.Since(begin) > 2*time.Second {
		t.Fatal("navbat kutish context'ni hurmat qilmadi")
	}

	close(release)
	if err := <-first; err != nil {
		t.Fatalf("birinchi so'rov: %v", err)
	}
	// Navbat bo'shadi: keyingi so'rov o'tadi.
	if _, err := c.LockState(context.Background()); err != nil {
		t.Fatalf("navbat bo'shagach so'rov xato: %v", err)
	}
}

func TestStatusBodyIsStable(t *testing.T) {
	// Status maydon tartibi va nomlari shartnoma (`helperStatusSchema`) bilan bir xil: kodlash natijasi o'zgarmasligi kerak.
	raw, err := json.Marshal(Status{Version: "1", Hook: "active", Policy: "active", ProcessGuard: "active", CAD: "blocked", Companion: "running", MeshAgent: "running"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"version":"1","hook":"active","policy":"active","processGuard":"active","cad":"blocked","companion":"running","meshAgent":"running"}`
	if !bytes.Equal(raw, []byte(want)) {
		t.Fatalf("Status JSON = %s\nwant        %s", raw, want)
	}
}
