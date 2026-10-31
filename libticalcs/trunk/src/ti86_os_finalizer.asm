; Reconstructed installer tail, NOT TI code or a recovered vendor file.
; Loaded over the native type-16 receiver at C600. The final received block
; replaces the active FBxx stack words with C600, handing execution here.
; Bank B holds the target page F at 8000..BFFF. C087 contains the native
; 79-byte programming routine already copied there by the receiver.
.section .text
.global _start
_start:
    di
    ld sp,0xf000
    ld hl,0x8000
    ld de,0x4000
    ld iy,64
next_block:
    push iy
    push hl
    ld c,15
    call 0xc087
    pop hl
    inc h
    pop iy
    dec iy
    push iy
    pop bc
    ld a,b
    or c
    jr nz,next_block
    xor a
    out (0x06),a
    rst 0
