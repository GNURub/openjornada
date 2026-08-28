// Package protocol implements the bounded OJUSB/1 control transport.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
)

const (
	Prefix          = "OJUSB/1 "
	MaxMessageBytes = 4096
)

var (
	ErrClosed          = errors.New("ojusb: client closed")
	ErrInvalidMessage  = errors.New("ojusb: invalid message")
	ErrMessageTooLarge = errors.New("ojusb: message too large")
	ErrTransport       = errors.New("ojusb: transport failure")
	ErrHandshake       = errors.New("ojusb: handshake failed")
)

type Request struct {
	Version int         `json:"v"`
	ID      string      `json:"id"`
	Command string      `json:"command"`
	Payload interface{} `json:"payload"`
}

type Event struct {
	ID      string
	Code    string
	Message string
	Data    json.RawMessage
}

type Capabilities struct {
	Status               bool `json:"status"`
	Doctor               bool `json:"doctor"`
	StructuredLogs       bool `json:"structuredLogs"`
	Reboot               bool `json:"reboot"`
	PhysicalFactoryReset bool `json:"physicalFactoryReset"`
	ProvisioningRecovery bool `json:"provisioningRecovery"`
	FirmwareInstall      bool `json:"firmwareInstall"`
	NegotiatedBaud       bool `json:"negotiatedBaud"`
}

type Hello struct {
	ProtocolVersion int          `json:"protocolVersion"`
	Board           string       `json:"board"`
	FirmwareVersion string       `json:"firmwareVersion"`
	Mode            string       `json:"mode"`
	Capabilities    Capabilities `json:"capabilities"`
}

type DeviceError struct{ Code string }

func (err *DeviceError) Error() string { return fmt.Sprintf("ojusb: device error %s", err.Code) }

type response struct {
	Version int             `json:"v"`
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}
