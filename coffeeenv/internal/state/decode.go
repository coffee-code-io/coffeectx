package state

import "encoding/json"

// decodeParams re-decodes a raw state's opaque param bag into a typed struct via
// a JSON round-trip (the CUE-decoded map is JSON-compatible). Handlers call this
// from Decode.
func decodeParams(rs RawState, dst any) error {
	b, err := json.Marshal(rs.Params)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}
