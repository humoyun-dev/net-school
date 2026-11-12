//go:build !windows

package nativehost

import (
	"errors"
	"io"
)

// Dial faqat Windows'da (Companion web pipe'i).
func Dial() (io.ReadWriteCloser, error) { return nil, errors.New("native host faqat Windows'da") }
