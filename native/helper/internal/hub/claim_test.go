package hub

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

// TS bilan umumiy vektorlar (apps/companion/test/signature-fixture.test.ts `claimProof`).
const claimFixturePath = "../../../../packages/contracts/fixtures/claim-proof.json"

func TestClaimProofMatchesCompanion(t *testing.T) {
	raw, err := os.ReadFile(filepath.FromSlash(claimFixturePath))
	if err != nil {
		t.Fatalf("fixture o'qilmadi: %v", err)
	}
	var fixture struct {
		Vectors []struct {
			Name, PrivateKeyPem, Token, ExpectedPublicKey, ExpectedProof string
		} `json:"vectors"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Vectors) == 0 {
		t.Fatal("vektor yo'q")
	}
	for _, v := range fixture.Vectors {
		key, err := LoadKey(writeKeyPEM(t, v.PrivateKeyPem))
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		pub, err := EncodePublicKey(key.Public().(ed25519.PublicKey))
		if err != nil || pub != v.ExpectedPublicKey {
			t.Fatalf("%s: public key %q (%v), want %q", v.Name, pub, err, v.ExpectedPublicKey)
		}
		if got := ClaimProof(key, v.Token, pub); got != v.ExpectedProof {
			t.Fatalf("%s: proof %q, want %q", v.Name, got, v.ExpectedProof)
		}
	}
}

func TestGenerateKeyPEMLoads(t *testing.T) {
	pemBytes, key, err := GenerateKeyPEM()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(pemBytes)
	if block == nil || block.Type != "PRIVATE KEY" {
		t.Fatalf("PEM turi: %v", block)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil || !key.Equal(parsed) {
		t.Fatalf("PKCS#8 mos emas: %v", err)
	}
	pub, _ := EncodePublicKey(key.Public().(ed25519.PublicKey))
	proof, err := base64.RawURLEncoding.DecodeString(ClaimProof(key, "nse_x", pub))
	if err != nil || !ed25519.Verify(key.Public().(ed25519.PublicKey), []byte("NSCLAIM1\nnse_x\n"+pub), proof) {
		t.Fatalf("proof tekshirilmadi: %v", err)
	}
}
