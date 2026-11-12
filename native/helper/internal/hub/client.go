package hub

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"time"
)

const (
	lockStatePath = "/api/v1/device/helper/lock-state"
	statusPath    = "/api/v1/device/helper/status"

	// requestTimeout va maxResponseBytes Companion `hub-client.ts` bilan bir xil (10 s, 2 MiB).
	requestTimeout   = 10 * time.Second
	maxResponseBytes = 2 << 20
	// defaultRetryDelay: 401 dan keyin soatni tuzatib qayta urinishdan oldingi qisqa pauza (Companion: 50 ms).
	defaultRetryDelay = 50 * time.Millisecond
)

// LockState hub `helperLockStateSchema` javobi: faol dars overlay'ining ko'zgusi.
// Dars yo'q bo'lsa `Locked == false` va `Sequence == nil`. Sequence uint64 sifatida o'qiladigan o'nli son qatori
// (hub global monoton `commands.seq`); uni solishtirish `lock` paketining ishi.
type LockState struct {
	Locked       bool    `json:"locked"`
	Sequence     *string `json:"sequence"`
	LeaseSeconds int     `json:"leaseSeconds"`
}

// Status helper komponentlarining joriy holati (`helperStatusSchema`). Qiymatlar quyidagi konstantalardan; hub
// boshqa qiymatni 400 bilan rad etadi. Hamma maydon satr, shuning uchun Status `==` bilan solishtiriladi.
type Status struct {
	Version      string `json:"version"`
	Hook         string `json:"hook"`
	Policy       string `json:"policy"`
	ProcessGuard string `json:"processGuard"`
	CAD          string `json:"cad"`
	Companion    string `json:"companion"`
	MeshAgent    string `json:"meshAgent"`
}

// Hook, Policy va ProcessGuard qiymatlari.
const (
	ComponentActive = "active"
	ComponentOff    = "off"
	ComponentFailed = "failed"
)

// CAD qiymatlari.
const (
	CADBlocked     = "blocked"
	CADUnavailable = "unavailable"
	CADFailed      = "failed"
	CADOff         = "off"
)

// Companion qiymatlari.
const (
	CompanionRunning    = "running"
	CompanionRestarting = "restarting"
	CompanionNoSession  = "no_session"
)

// MeshAgent qiymatlari.
const (
	MeshAgentRunning   = "running"
	MeshAgentRestarted = "restarted"
	MeshAgentStopped   = "stopped"
)

// StatusError hub 2xx dan boshqa status bilan javob berganda qaytadi. Code va Message hub xato konverti
// (`{"error":{"code","message"}}`) bo'lsa to'ldiriladi.
type StatusError struct {
	Status  int
	Code    string
	Message string
}

func (e *StatusError) Error() string {
	if e.Code != "" {
		return fmt.Sprintf("hub %d javob berdi: %s (%s)", e.Status, e.Message, e.Code)
	}
	return fmt.Sprintf("hub %d javob berdi: %s", e.Status, e.Message)
}

// Client hub bilan imzolangan HTTPS mijozi.
//
// TLS tekshiruvi hech qachon o'chirilmaydi: `caPEM` berilsa faqat shu CA'ga ishoniladi (tizim root'lari
// qo'shilmaydi), aks holda tizim root'lariga; hostname har doim tekshiriladi. Redirect'lar kuzatilmaydi:
// imzolangan so'rov boshqa manzilga ketmasin.
//
// Client bir vaqtda bitta imzolangan so'rovni bajaradi (imzolashdan javobni o'qishgacha, 401 dan keyingi qayta
// urinish ham shu ichida). Sabab: parallel so'rovlar tarmoqda tartibsiz yetib borsa, hub `ts > last_signed_ts`
// talabi bilan kichikroq timestamp'lini rad etadi (Signer timestamp'ni imzolash tartibida o'stiradi, yetib borish
// tartibini esa kafolatlay olmaydi). Navbat kutish context bilan bekor qilinadi. Bir nechta goroutine'dan xavfsiz.
type Client struct {
	origin string
	http   *http.Client
	signer *Signer
	// gate sig'imi 1: kanal mutex o'rniga, chunki navbat kutayotgan chaqiruv ctx bilan chiqib keta olishi kerak.
	gate       chan struct{}
	retryDelay time.Duration
}

// NewClient `origin` faqat `https://host[:port]` ko'rinishida bo'lishi kerak (yo'l, so'rov, foydalanuvchi yo'q).
// `caPEM` bo'sh bo'lsa tizim root'lari, aks holda faqat shu PEM'dagi sertifikatlar; ularda birorta ham sertifikat
// bo'lmasa xato (jimgina tizim root'lariga qaytilmaydi).
func NewClient(origin string, caPEM []byte, signer *Signer) (*Client, error) {
	if signer == nil {
		return nil, errors.New("hub mijozi uchun imzolovchi kerak")
	}
	if err := checkOrigin(origin); err != nil {
		return nil, err
	}
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if len(caPEM) > 0 {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, errors.New("hub CA PEM'ida bitta ham sertifikat yo'q")
		}
		tlsConfig.RootCAs = pool
	}
	transport := &http.Transport{
		// Hub to'g'ridan-to'g'ri maktab tarmog'ida: proksi muhit o'zgaruvchilari SYSTEM xizmatiga ta'sir qilmasin.
		Proxy:                 nil,
		DialContext:           (&net.Dialer{Timeout: requestTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       tlsConfig,
		TLSHandshakeTimeout:   requestTimeout,
		ResponseHeaderTimeout: requestTimeout,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          2,
	}
	return &Client{
		origin: origin,
		http: &http.Client{
			Transport: transport,
			Timeout:   requestTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		signer:     signer,
		gate:       make(chan struct{}, 1),
		retryDelay: defaultRetryDelay,
	}, nil
}

// checkOrigin Companion `parseOrigin` kabi: faqat `https://host[:port]`.
func checkOrigin(origin string) error {
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.Opaque != "" || u.User != nil ||
		u.Path != "" || u.RawPath != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return errors.New("hub origin faqat https://host[:port] bo'lishi kerak")
	}
	return nil
}

// Close bo'sh turgan ulanishlarni yopadi.
func (c *Client) Close() { c.http.CloseIdleConnections() }

// LockState hub'dan joriy bloklash holatini oladi (heartbeat emas, hub holat yaratmaydi).
// `leaseSeconds` musbat bo'lmasa javob yaroqsiz hisoblanadi.
func (c *Client) LockState(ctx context.Context) (LockState, error) {
	res, err := c.do(ctx, http.MethodGet, lockStatePath, nil)
	if err != nil {
		return LockState{}, err
	}
	var state LockState
	if err := json.Unmarshal(res.body, &state); err != nil {
		return LockState{}, fmt.Errorf("hub lock-state javobi o'qilmadi: %w", err)
	}
	if state.LeaseSeconds <= 0 {
		return LockState{}, errors.New("hub lock-state javobida leaseSeconds musbat emas")
	}
	return state, nil
}

// ReportStatus helper holatini hub'ga yuboradi (204).
func (c *Client) ReportStatus(ctx context.Context, status Status) error {
	body, err := json.Marshal(status)
	if err != nil {
		return err
	}
	_, err = c.do(ctx, http.MethodPut, statusPath, body)
	return err
}

type response struct {
	status int
	date   string
	body   []byte
}

// do so'rovni navbat bilan bajaradi va 2xx bo'lmasa *StatusError qaytaradi. 401: soat noto'g'ri bo'lishi mumkin;
// javobdagi `Date` bilan imzo soati hub vaqtiga moslanadi va so'rov bir marta qayta imzolanib yuboriladi.
func (c *Client) do(ctx context.Context, method, path string, body []byte) (*response, error) {
	select {
	case c.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-c.gate }()

	res, err := c.once(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	if res.status == http.StatusUnauthorized {
		if hubTime, err := http.ParseTime(res.date); err == nil {
			c.signer.SyncClock(hubTime)
		}
		if err := sleep(ctx, c.retryDelay); err != nil {
			return nil, err
		}
		if res, err = c.once(ctx, method, path, body); err != nil {
			return nil, err
		}
	}
	if res.status < 200 || res.status >= 300 {
		return nil, statusError(res)
	}
	return res, nil
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// once so'rovni imzolaydi (har urinishda yangi timestamp) va yuboradi.
func (c *Client) once(ctx context.Context, method, path string, body []byte) (*response, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for name, values := range c.signer.Sign(method, path, body) {
		req.Header[name] = values
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxResponseBytes {
		return nil, errors.New("hub javobi juda katta")
	}
	return &response{status: resp.StatusCode, date: resp.Header.Get("Date"), body: raw}, nil
}

func statusError(res *response) *StatusError {
	e := &StatusError{Status: res.status, Message: fmt.Sprintf("status %d", res.status)}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	// JSON bo'lmagan javob: status yetarli.
	if json.Unmarshal(res.body, &envelope) == nil {
		e.Code = envelope.Error.Code
		if envelope.Error.Message != "" {
			e.Message = envelope.Error.Message
		}
	}
	return e
}
