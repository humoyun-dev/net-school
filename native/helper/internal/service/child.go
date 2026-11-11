package service

import (
	"context"
	"sync"

	"github.com/humoyun-dev/net-school/native/helper/internal/supervise"
)

// SessionChild Child realizatsiyasi: har sessiya uchun alohida supervise.Supervisor. Move eski Supervisor'ni
// to'xtatadi (jarayoni o'ldiriladi va tugashi kutiladi), keyin yangi sessiya uchun yangisini ishga tushiradi.
// Move, State va LastError istalgan goroutine'dan xavfsiz (Move'lar o'zaro ketma-ket).
type SessionChild struct {
	name     string
	launcher func(Session) supervise.Launcher
	clock    supervise.Clock

	moveMu sync.Mutex // Move'lar ketma-ketligi

	mu      sync.Mutex
	cur     *supervise.Supervisor
	cancel  context.CancelFunc
	done    chan struct{}
	lastErr error // to'xtatilgan Supervisor'larning oxirgi xatosi
}

// NewSessionChild launcher har sessiya uchun shu sessiyada jarayon ishga tushiradigan Launcher qaytaradi.
func NewSessionChild(name string, launcher func(Session) supervise.Launcher, clock supervise.Clock) *SessionChild {
	return &SessionChild{name: name, launcher: launcher, clock: clock}
}

func (c *SessionChild) Move(s Session, ok bool) {
	c.moveMu.Lock()
	defer c.moveMu.Unlock()

	c.mu.Lock()
	cur, cancel, done := c.cur, c.cancel, c.done
	c.mu.Unlock()
	if cur != nil {
		cancel()
		<-done
		c.mu.Lock()
		if err := cur.LastError(); err != nil {
			c.lastErr = err
		}
		c.cur, c.cancel, c.done = nil, nil, nil
		c.mu.Unlock()
	}
	if !ok {
		return
	}
	sup := supervise.NewSupervisor(c.name, c.launcher(s), c.clock)
	ctx, cancelNew := context.WithCancel(context.Background())
	doneNew := make(chan struct{})
	c.mu.Lock()
	c.cur, c.cancel, c.done = sup, cancelNew, doneNew
	c.mu.Unlock()
	go func() {
		defer close(doneNew)
		sup.Run(ctx)
	}()
}

// State joriy Supervisor holati; sessiya yo'q bo'lsa supervise.StateStopped.
func (c *SessionChild) State() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cur == nil {
		return supervise.StateStopped
	}
	return c.cur.State()
}

// LastError joriy Supervisor'ning oxirgi xatosi, u hali xato ko'rmagan bo'lsa oldingilarniki.
func (c *SessionChild) LastError() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.cur != nil {
		if err := c.cur.LastError(); err != nil {
			return err
		}
	}
	return c.lastErr
}
