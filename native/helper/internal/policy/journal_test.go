package policy

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"testing"
)

const (
	sidA = "S-1-5-21-1000-1000-1000-1001"
	sidB = "S-1-5-21-1000-1000-1000-1002"

	wantSystemKey   = `Software\Microsoft\Windows\CurrentVersion\Policies\System`
	wantExplorerKey = `Software\Microsoft\Windows\CurrentVersion\Policies\Explorer`
	wantMachineKey  = `SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System`
)

var errBoom = errors.New("reyestr xatosi")

type regKey struct{ root, key, name string }

type regOp struct {
	kind string // "read" | "write" | "delete"
	k    regKey
	v    uint32
}

// fakeRegistry Registry'ning xotiradagi nusxasi: amallarni ketma-ketlikda yozib boradi va xatolarni qo'lda yoqish mumkin.
type fakeRegistry struct {
	values map[regKey]uint32
	ops    []regOp

	// onWrite har Write'dan oldin chaqiriladi (jurnal tartibini tekshirish uchun).
	onWrite func(k regKey)
	// failRead/failWrite/failDelete nil bo'lmasa va xato qaytarsa, amal bajarilmaydi.
	failRead   func(k regKey) error
	failWrite  func(k regKey) error
	failDelete func(k regKey) error
}

func newFakeRegistry() *fakeRegistry { return &fakeRegistry{values: map[regKey]uint32{}} }

func (r *fakeRegistry) Read(root, key, name string) (*uint32, error) {
	k := regKey{root, key, name}
	r.ops = append(r.ops, regOp{kind: "read", k: k})
	if r.failRead != nil {
		if err := r.failRead(k); err != nil {
			return nil, err
		}
	}
	v, ok := r.values[k]
	if !ok {
		return nil, nil
	}
	return &v, nil
}

func (r *fakeRegistry) Write(root, key, name string, v uint32) error {
	k := regKey{root, key, name}
	if r.onWrite != nil {
		r.onWrite(k)
	}
	r.ops = append(r.ops, regOp{kind: "write", k: k, v: v})
	if r.failWrite != nil {
		if err := r.failWrite(k); err != nil {
			return err
		}
	}
	r.values[k] = v
	return nil
}

func (r *fakeRegistry) Delete(root, key, name string) error {
	k := regKey{root, key, name}
	r.ops = append(r.ops, regOp{kind: "delete", k: k})
	if r.failDelete != nil {
		if err := r.failDelete(k); err != nil {
			return err
		}
	}
	delete(r.values, k)
	return nil
}

func (r *fakeRegistry) opsOfKind(kind string) []regOp {
	var out []regOp
	for _, op := range r.ops {
		if op.kind == kind {
			out = append(out, op)
		}
	}
	return out
}

func userRootOf(sid string) string { return `HKU\` + sid }

// userKeys sid uchun kutilgan 5 ta qiymat; machineKeys — HKLM'dagi bitta qiymat. Qiymatlar atayin
// ishlab chiqarish jadvalidan emas, qo'lda yozilgan: jadvaldagi xatoni test ushlashi kerak.
func userKeys(sid string) []regKey {
	root := userRootOf(sid)
	return []regKey{
		{root, wantSystemKey, "DisableTaskMgr"},
		{root, wantSystemKey, "DisableLockWorkstation"},
		{root, wantSystemKey, "DisableChangePassword"},
		{root, wantExplorerKey, "NoLogoff"},
		{root, wantExplorerKey, "NoClose"},
	}
}

func machineKeys() []regKey {
	return []regKey{{"HKLM", wantMachineKey, "HideFastUserSwitching"}}
}

func allKeys(sid string) []regKey { return append(userKeys(sid), machineKeys()...) }

func sortedKeys(keys []regKey) []regKey {
	out := slices.Clone(keys)
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.root != b.root {
			return a.root < b.root
		}
		if a.key != b.key {
			return a.key < b.key
		}
		return a.name < b.name
	})
	return out
}

func newPolicy(t *testing.T) (*Policy, *fakeRegistry, string) {
	t.Helper()
	reg := newFakeRegistry()
	path := filepath.Join(t.TempDir(), "policy-journal.json")
	return NewPolicy(reg, path), reg, path
}

func readJournal(t *testing.T, path string) []journalEntry {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("jurnal o'qilmadi: %v", err)
	}
	var entries []journalEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		t.Fatalf("jurnal JSON emas: %v", err)
	}
	return entries
}

func assertNoJournal(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("jurnal fayli o'chirilishi kerak edi, Stat xatosi: %v", err)
	}
}

func assertValue(t *testing.T, reg *fakeRegistry, k regKey, want *uint32) {
	t.Helper()
	got, ok := reg.values[k]
	switch {
	case want == nil && ok:
		t.Errorf("%v: qiymat yo'q bo'lishi kerak, bor: %d", k, got)
	case want != nil && !ok:
		t.Errorf("%v: qiymat %d bo'lishi kerak, yo'q", k, *want)
	case want != nil && got != *want:
		t.Errorf("%v: qiymat = %d, kutilgan %d", k, got, *want)
	}
}

func u32(v uint32) *uint32 { return &v }

func TestApplyWritesExactPolicyValues(t *testing.T) {
	p, reg, _ := newPolicy(t)
	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	var written []regKey
	for _, op := range reg.opsOfKind("write") {
		if op.v != 1 {
			t.Errorf("%v: yozilgan qiymat %d, kutilgan 1", op.k, op.v)
		}
		written = append(written, op.k)
	}
	if got, want := sortedKeys(written), sortedKeys(allKeys(sidA)); !slices.Equal(got, want) {
		t.Fatalf("yozilgan qiymatlar:\n got  %v\n want %v", got, want)
	}
	for _, k := range allKeys(sidA) {
		assertValue(t, reg, k, u32(1))
	}
	if !p.Pending() {
		t.Error("Apply'dan keyin Pending() true bo'lishi kerak")
	}
}

func TestApplyJournalsBeforeWriting(t *testing.T) {
	p, reg, path := newPolicy(t)
	reg.values[regKey{userRootOf(sidA), wantSystemKey, "DisableTaskMgr"}] = 0
	writes := 0
	reg.onWrite = func(k regKey) {
		writes++
		entries := readJournal(t, path)
		if len(entries) != 6 {
			t.Errorf("%v yozilishidan oldin jurnalda %d yozuv bor, kutilgan 6", k, len(entries))
			return
		}
		for _, e := range entries {
			if e.Name == "DisableTaskMgr" {
				if e.Previous == nil || *e.Previous != 0 {
					t.Errorf("DisableTaskMgr oldingi qiymati jurnalda = %v, kutilgan 0", e.Previous)
				}
			} else if e.Previous != nil {
				t.Errorf("%s oldingi qiymati jurnalda = %d, kutilgan yo'q", e.Name, *e.Previous)
			}
		}
	}
	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if writes != 6 {
		t.Fatalf("Write chaqiruvlari = %d, kutilgan 6", writes)
	}
	// HKU yozuvlari SID'ni, HKLM yozuvi esa bo'sh SID'ni saqlaydi.
	for _, e := range readJournal(t, path) {
		wantSID := sidA
		if e.Root == "HKLM" {
			wantSID = ""
		}
		if e.SID != wantSID {
			t.Errorf("%s/%s sid = %q, kutilgan %q", e.Root, e.Name, e.SID, wantSID)
		}
	}
}

func TestApplyWriteFailureKeepsFullJournal(t *testing.T) {
	p, reg, path := newPolicy(t)
	reg.failWrite = func(k regKey) error {
		if k.name == "DisableLockWorkstation" {
			return errBoom
		}
		return nil
	}
	err := p.Apply(sidA)
	if !errors.Is(err, errBoom) {
		t.Fatalf("Apply xatosi = %v, kutilgan errBoom", err)
	}
	// Bitta qiymat yozilmasa ham qolganlari yoziladi: bloklash imkon qadar to'liq bo'ladi.
	if got := len(reg.opsOfKind("write")); got != 6 {
		t.Errorf("Write urinishlari = %d, kutilgan 6", got)
	}
	if got := len(readJournal(t, path)); got != 6 {
		t.Fatalf("jurnalda %d yozuv, kutilgan 6", got)
	}
	reg.failWrite = nil
	if err := p.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	for _, k := range allKeys(sidA) {
		assertValue(t, reg, k, nil)
	}
	assertNoJournal(t, path)
}

func TestApplyReadFailureWritesNothing(t *testing.T) {
	p, reg, path := newPolicy(t)
	reg.failRead = func(k regKey) error {
		if k.name == "NoClose" {
			return errBoom
		}
		return nil
	}
	if err := p.Apply(sidA); !errors.Is(err, errBoom) {
		t.Fatalf("Apply xatosi = %v, kutilgan errBoom", err)
	}
	if n := len(reg.opsOfKind("write")); n != 0 {
		t.Errorf("oldingi qiymat o'qilmagan bo'lsa yozuv bo'lmasligi kerak, Write = %d", n)
	}
	assertNoJournal(t, path)
}

func TestRestoreReturnsPreviousValues(t *testing.T) {
	p, reg, path := newPolicy(t)
	taskMgr := regKey{userRootOf(sidA), wantSystemKey, "DisableTaskMgr"}
	noLogoff := regKey{userRootOf(sidA), wantExplorerKey, "NoLogoff"}
	fastSwitch := regKey{"HKLM", wantMachineKey, "HideFastUserSwitching"}
	reg.values[taskMgr] = 0
	reg.values[noLogoff] = 7
	reg.values[fastSwitch] = 0

	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	if err := p.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	assertValue(t, reg, taskMgr, u32(0))
	assertValue(t, reg, noLogoff, u32(7))
	assertValue(t, reg, fastSwitch, u32(0))
	for _, k := range allKeys(sidA) {
		if k != taskMgr && k != noLogoff && k != fastSwitch {
			assertValue(t, reg, k, nil)
		}
	}
	if p.Pending() {
		t.Error("to'liq tiklangach Pending() false bo'lishi kerak")
	}
	assertNoJournal(t, path)
	// Atomik yozish vaqtinchalik fayl qoldirmaydi.
	if left, _ := os.ReadDir(filepath.Dir(path)); len(left) != 0 {
		t.Errorf("katalogda ortiqcha fayllar qoldi: %v", left)
	}
}

func TestApplyTwiceKeepsOriginalPrevious(t *testing.T) {
	p, reg, path := newPolicy(t)
	taskMgr := regKey{userRootOf(sidA), wantSystemKey, "DisableTaskMgr"}
	reg.values[taskMgr] = 0

	if err := p.Apply(sidA); err != nil {
		t.Fatalf("birinchi Apply: %v", err)
	}
	if err := p.Apply(sidA); err != nil {
		t.Fatalf("ikkinchi Apply: %v", err)
	}
	// Ikkinchi chaqiruv bizning o'z qiymatimizni "asl" deb o'qimaydi.
	if got := len(readJournal(t, path)); got != 6 {
		t.Errorf("jurnalda %d yozuv, kutilgan 6 (takroriy yozuv yo'q)", got)
	}
	if err := p.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	assertValue(t, reg, taskMgr, u32(0))
}

func TestApplyTwiceReassertsValues(t *testing.T) {
	p, reg, _ := newPolicy(t)
	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	// Foydalanuvchi (yoki boshqa dastur) qiymatni o'zgartirsa, keyingi Apply uni qayta o'rnatadi.
	tm := regKey{userRootOf(sidA), wantSystemKey, "DisableTaskMgr"}
	reg.values[tm] = 0
	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	assertValue(t, reg, tm, u32(1))
}

func TestStartRestoresLeftoverPolicy(t *testing.T) {
	first, reg, path := newPolicy(t)
	taskMgr := regKey{userRootOf(sidA), wantSystemKey, "DisableTaskMgr"}
	reg.values[taskMgr] = 0
	if err := first.Apply(sidA); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Jarayon o'lib, yangidan ishga tushdi: holat faqat jurnal faylida.
	restarted := NewPolicy(reg, path)
	if !restarted.Pending() {
		t.Fatal("qolib ketgan siyosat uchun Pending() true bo'lishi kerak")
	}
	if err := restarted.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	assertValue(t, reg, taskMgr, u32(0))
	for _, k := range allKeys(sidA) {
		if k != taskMgr {
			assertValue(t, reg, k, nil)
		}
	}
	if restarted.Pending() {
		t.Error("tiklangach Pending() false bo'lishi kerak")
	}
}

func TestRestoreWithoutJournalIsNoop(t *testing.T) {
	p, reg, _ := newPolicy(t)
	if p.Pending() {
		t.Error("jurnal yo'q: Pending() false bo'lishi kerak")
	}
	if err := p.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if len(reg.ops) != 0 {
		t.Errorf("jurnal yo'q: reyestrga tegilmasligi kerak, amallar: %v", reg.ops)
	}
}

func TestPolicyFollowsSessionUser(t *testing.T) {
	p, reg, path := newPolicy(t)
	fastSwitch := regKey{"HKLM", wantMachineKey, "HideFastUserSwitching"}
	reg.values[fastSwitch] = 0

	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply(sidA): %v", err)
	}
	reg.ops = nil
	if err := p.Apply(sidB); err != nil {
		t.Fatalf("Apply(sidB): %v", err)
	}

	// sidA'ga tegishli hamma amal sidB'ga birorta yozishdan oldin bo'lishi kerak.
	lastA, firstB := -1, -1
	for i, op := range reg.ops {
		switch op.k.root {
		case userRootOf(sidA):
			lastA = i
		case userRootOf(sidB):
			if op.kind == "write" && firstB == -1 {
				firstB = i
			}
		case "HKLM":
			if op.kind == "delete" {
				t.Errorf("HKLM qiymati foydalanuvchi almashganda o'chirilmasligi kerak (bo'shliq qoladi): %v", op)
			}
		}
	}
	if lastA == -1 || firstB == -1 || lastA > firstB {
		t.Fatalf("avval sidA tiklanishi, keyin sidB'ga yozilishi kerak (lastA=%d, firstB=%d): %v", lastA, firstB, reg.ops)
	}
	for _, k := range userKeys(sidA) {
		assertValue(t, reg, k, nil)
	}
	for _, k := range allKeys(sidB) {
		assertValue(t, reg, k, u32(1))
	}
	if got := len(readJournal(t, path)); got != 6 {
		t.Errorf("jurnalda %d yozuv, kutilgan 6 (sidB'niki + HKLM)", got)
	}

	// HKLM'ning asl qiymati foydalanuvchi almashgandan keyin ham saqlanib qoladi.
	if err := p.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	assertValue(t, reg, fastSwitch, u32(0))
	for _, k := range userKeys(sidB) {
		assertValue(t, reg, k, nil)
	}
}

func TestStaleUserRestoreFailureDoesNotBlockNewUser(t *testing.T) {
	p, reg, path := newPolicy(t)
	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply(sidA): %v", err)
	}
	// sidA'ning hive'i yuklanmagan: uning qiymatlarini hozir tiklab bo'lmaydi.
	reg.failDelete = func(k regKey) error {
		if k.root == userRootOf(sidA) {
			return errBoom
		}
		return nil
	}
	err := p.Apply(sidB)
	if !errors.Is(err, errBoom) {
		t.Fatalf("Apply(sidB) xatosi = %v, kutilgan errBoom (tiklanmagan qoldiq haqida)", err)
	}
	// Ammo yangi foydalanuvchi baribir bloklanadi.
	for _, k := range allKeys(sidB) {
		assertValue(t, reg, k, u32(1))
	}
	// 5 (sidA, tiklanmagan) + 5 (sidB) + 1 (HKLM).
	if got := len(readJournal(t, path)); got != 11 {
		t.Fatalf("jurnalda %d yozuv, kutilgan 11", got)
	}

	// Hive yana yuklanganda keyingi Apply qoldiqni tiklaydi.
	reg.failDelete = nil
	if err := p.Apply(sidB); err != nil {
		t.Fatalf("Apply(sidB) qayta: %v", err)
	}
	for _, k := range userKeys(sidA) {
		assertValue(t, reg, k, nil)
	}
	if got := len(readJournal(t, path)); got != 6 {
		t.Errorf("jurnalda %d yozuv, kutilgan 6", got)
	}
}

func TestPartialRestoreKeepsFailedEntries(t *testing.T) {
	p, reg, path := newPolicy(t)
	taskMgr := regKey{userRootOf(sidA), wantSystemKey, "DisableTaskMgr"}
	noLogoff := regKey{userRootOf(sidA), wantExplorerKey, "NoLogoff"}
	reg.values[taskMgr] = 0
	if err := p.Apply(sidA); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	// Biri oldingi qiymatni yozishda (Write), biri o'chirishda (Delete) yiqiladi.
	reg.failWrite = func(k regKey) error {
		if k == taskMgr {
			return errBoom
		}
		return nil
	}
	reg.failDelete = func(k regKey) error {
		if k == noLogoff {
			return errBoom
		}
		return nil
	}
	err := p.Restore()
	if !errors.Is(err, errBoom) {
		t.Fatalf("Restore xatosi = %v, kutilgan errBoom", err)
	}
	if !p.Pending() {
		t.Error("tiklanmagan yozuvlar bor: Pending() true bo'lishi kerak")
	}
	left := readJournal(t, path)
	if len(left) != 2 {
		t.Fatalf("jurnalda %d yozuv qoldi, kutilgan 2: %v", len(left), left)
	}
	names := []string{left[0].Name, left[1].Name}
	slices.Sort(names)
	if !slices.Equal(names, []string{"DisableTaskMgr", "NoLogoff"}) {
		t.Errorf("jurnalda qolgan yozuvlar = %v", names)
	}
	// Muvaffaqiyatli tiklanganlari tegilmagan, jurnaldan chiqarilgan.
	for _, k := range allKeys(sidA) {
		if k != taskMgr && k != noLogoff {
			assertValue(t, reg, k, nil)
		}
	}

	// Xato bartaraf bo'lgach keyingi urinish davom ettiradi.
	reg.failWrite, reg.failDelete = nil, nil
	if err := p.Restore(); err != nil {
		t.Fatalf("ikkinchi Restore: %v", err)
	}
	assertValue(t, reg, taskMgr, u32(0))
	assertValue(t, reg, noLogoff, nil)
	assertNoJournal(t, path)
}

func TestApplyRejectsInvalidSID(t *testing.T) {
	for _, sid := range []string{
		"",
		"..",
		"S-1-5",
		`S-1-5-21-1-2-3-1001\..\..`,
		`S-1-5-21-1-2-3-1001\Software`,
		"s-1-5-21-1-2-3-1001",
		"S-1-5-21-1-2-3-1001 ",
		"HKU",
		"S-1-5--21",
	} {
		p, reg, path := newPolicy(t)
		if err := p.Apply(sid); err == nil {
			t.Errorf("Apply(%q) xato qaytarishi kerak edi", sid)
		}
		if len(reg.ops) != 0 {
			t.Errorf("Apply(%q): reyestrga tegilmasligi kerak, amallar: %v", sid, reg.ops)
		}
		assertNoJournal(t, path)
	}
}

func TestBrokenJournalIsRefusedNotIgnored(t *testing.T) {
	root := `"root":"HKU\\S-1-5-21-1-2-3-4","key":"k","name":"n","previous":null,"sid":"S-1-5-21-1-2-3-4"`
	cases := map[string]string{
		"json emas":            `not json`,
		"noma'lum root":        `[{"root":"HKCU","key":"k","name":"n","previous":null,"sid":""}]`,
		"HKU SID'siz":          `[{"root":"HKU","key":"k","name":"n","previous":null,"sid":""}]`,
		"HKLM va sid":          `[{"root":"HKLM","key":"k","name":"n","previous":null,"sid":"S-1-5-21-1-2-3-4"}]`,
		"sid root'ga mos emas": `[{"root":"HKU\\S-1-5-21-1-2-3-4","key":"k","name":"n","previous":null,"sid":"S-1-5-21-9-9-9-9"}]`,
		"bo'sh key":            `[{"root":"HKLM","key":"","name":"n","previous":null,"sid":""}]`,
		"bo'sh name":           `[{"root":"HKLM","key":"k","name":"","previous":null,"sid":""}]`,
		"noma'lum maydon":      `[{` + root + `,"extra":1}]`,
		"ortiqcha ma'lumot":    `[] []`,
		"uint32 dan katta":     `[{"root":"HKLM","key":"k","name":"n","previous":4294967296,"sid":""}]`,
		"manfiy":               `[{"root":"HKLM","key":"k","name":"n","previous":-1,"sid":""}]`,
	}
	for name, content := range cases {
		t.Run(name, func(t *testing.T) {
			p, reg, path := newPolicy(t)
			if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := p.Apply(sidA); err == nil {
				t.Error("Apply buzilgan jurnalda xato qaytarishi kerak")
			}
			if err := p.Restore(); err == nil {
				t.Error("Restore buzilgan jurnalda xato qaytarishi kerak")
			}
			// Buzilgan jurnal "bo'sh" deb o'qilmaydi: qaytarish kerak bo'lgan holat jimgina yo'qolmasin.
			if !p.Pending() {
				t.Error("buzilgan jurnalda Pending() true bo'lishi kerak")
			}
			if len(reg.ops) != 0 {
				t.Errorf("reyestrga tegilmasligi kerak, amallar: %v", reg.ops)
			}
			raw, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(raw, []byte(content)) {
				t.Errorf("buzilgan jurnal fayli o'zgarmasligi kerak (xato: %v)", err)
			}
		})
	}
}

func TestEmptyJournalFileMeansNothingPending(t *testing.T) {
	p, reg, path := newPolicy(t)
	if err := os.WriteFile(path, []byte(`[]`), 0o600); err != nil {
		t.Fatal(err)
	}
	if p.Pending() {
		t.Error("bo'sh ro'yxat: Pending() false bo'lishi kerak")
	}
	if err := p.Restore(); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if len(reg.ops) != 0 {
		t.Errorf("reyestrga tegilmasligi kerak: %v", reg.ops)
	}
	assertNoJournal(t, path)
}

func TestParseRoot(t *testing.T) {
	ok := []struct {
		root, hive, sid string
	}{
		{"HKLM", hiveMachine, ""},
		{`HKU\` + sidA, hiveUsers, sidA},
		{`HKU\S-1-5-18`, hiveUsers, "S-1-5-18"},
	}
	for _, c := range ok {
		hive, sid, err := parseRoot(c.root)
		if err != nil || hive != c.hive || sid != c.sid {
			t.Errorf("parseRoot(%q) = (%q, %q, %v), kutilgan (%q, %q, nil)", c.root, hive, sid, err, c.hive, c.sid)
		}
	}
	for _, root := range []string{
		"", "HKCU", "HKCR", "HKCC", "hklm", "HKLM\\", `HKLM\Software`, "HKU", `HKU\`, `HKU\x`,
		`HKU\.DEFAULT`, `HKU\` + sidA + `\Software`, `HKU\..\` + sidA, "HKU/" + sidA, " HKLM",
	} {
		if hive, sid, err := parseRoot(root); err == nil {
			t.Errorf("parseRoot(%q) xato qaytarishi kerak edi, oldi (%q, %q)", root, hive, sid)
		}
	}
}
