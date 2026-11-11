package hub

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
)

// GenerateKeyPEM yangi helper kaliti: Ed25519, PKCS#8 PEM (LoadKey o'qiydigan va Companion generateDeviceKey
// yozadigan format).
func GenerateKeyPEM() ([]byte, ed25519.PrivateKey, error) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), key, nil
}

// EncodePublicKey hub kutgan ko'rinish: SPKI DER, base64url (padding'siz), Companion `generateDeviceKey` kabi.
func EncodePublicKey(pub ed25519.PublicKey) (string, error) {
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(der), nil
}

// ClaimProof Companion `claimProof` (identity.ts) bilan bayt-bayt bir xil: imzo(`NSCLAIM1\n{token}\n{publicKey}`),
// base64url. Kalit egaligini isbotlaydi va uni bir martalik enrollment tokeniga bog'laydi.
func ClaimProof(key ed25519.PrivateKey, token, publicKey string) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte("NSCLAIM1\n"+token+"\n"+publicKey)))
}

// CheckOrigin hub origin'i faqat `https://host[:port]` (yo'l, so'rov, foydalanuvchi yo'q).
func CheckOrigin(origin string) error { return checkOrigin(origin) }
