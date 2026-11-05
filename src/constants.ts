/** C0DATA control code byte constants (DESIGN.md "Assigned Control Codes"). */

export const VERSION = '1.0.0-dev'

export const SOH = 0x01 // Heading: a key for the value after it, or SOH RS a header row
export const STX = 0x02 // Start of text (literal value)
export const ETX = 0x03 // End of text
export const EOT = 0x04 // End of document
export const ENQ = 0x05 // Reference
export const BEL = 0x07 // Comment: a note, or marks the next element dead
export const DLE = 0x10 // Recurse: opens a nested level (outside text); escape (inside text)
export const SYN = 0x16 // Start of document, then the heading
export const ETB = 0x17 // Commit marker (stream mode)
export const CAN = 0x18 // Close a nested level
export const EM  = 0x19 // End of medium: raw blob follows
export const SUB = 0x1a // Substitution (C0-DIFF)
export const FS  = 0x1c // File separator
export const GS  = 0x1d // Group separator
export const RS  = 0x1e // Record separator
export const US  = 0x1f // Unit separator

// Layout codes outside text
export const HT = 0x09
export const LF = 0x0a
export const CR = 0x0d
export const SP = 0x20

/** The sixteen assigned structural and framing codes. */
export const ASSIGNED: ReadonlySet<number> = new Set([
  SOH, STX, ETX, EOT, ENQ, BEL, DLE, SYN, ETB, CAN, EM, SUB, FS, GS, RS, US,
])

/** The seven codes that take a DLE inside text. */
export const TEXT_ESCAPED: ReadonlySet<number> = new Set([STX, ETX, DLE, ETB, EOT, SYN, EM])

const ESCAPED_TABLE = new Uint8Array(32)
for (const b of TEXT_ESCAPED) ESCAPED_TABLE[b] = 1

export function isLayout(byte: number): boolean {
  return byte === SP || byte === HT || byte === LF || byte === CR
}

export function isControl(byte: number): boolean {
  return byte < 0x20
}

/** Whether a byte must be DLE-escaped inside text. */
export function isTextEscaped(byte: number): boolean {
  return byte < 0x20 && ESCAPED_TABLE[byte] === 1
}
