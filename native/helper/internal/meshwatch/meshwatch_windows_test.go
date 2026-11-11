//go:build windows

package meshwatch

import "testing"

// CI runner'da bunday xizmat yo'q: Check `stopped` va xato qaytaradi (yolg'on `running` emas).
func TestMissingServiceIsStopped(t *testing.T) {
	state, err := check("NetSchoolNoSuchService")
	if state != StateStopped || err == nil {
		t.Fatalf("check = (%q, %v), kutilgan (stopped, xato)", state, err)
	}
}
