package hooks

import (
	"bytes"
	"crypto/sha256"
	"testing"
)

// TestFrozenHMACLabels pins the two HMAC domain-separation labels. They are
// frozen because live state is an HMAC over these exact bytes: a Slack
// session capability held by a running bb server, and an open Linear install
// state. Renaming either label changes every derived key, so a service
// cutover that carries a different label orphans the capabilities the
// running bb servers already hold. Do not edit either string without a
// dual-label migration that accepts both.
func TestFrozenHMACLabels(t *testing.T) {
	const wantSlackCapabilityLabel = "bb-gate-hooks slack session capability v1"
	if slackCapabilityLabel != wantSlackCapabilityLabel {
		t.Errorf("slackCapabilityLabel = %q, want the frozen %q", slackCapabilityLabel, wantSlackCapabilityLabel)
	}

	const wantInstallStateLabel = "bb-gate-hooks linear install state\x00"
	const secret = "test-client-secret"
	want := sha256.Sum256([]byte(wantInstallStateLabel + secret))
	s := &Sessions{ClientSecret: []byte(secret)}
	if got := s.stateKey(); !bytes.Equal(got, want[:]) {
		t.Errorf("stateKey() = %x, want the key derived from the frozen %q", got, wantInstallStateLabel)
	}
}
