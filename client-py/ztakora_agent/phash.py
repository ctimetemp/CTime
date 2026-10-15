import math

# dHash over a 9x8 grayscale grid: 64 bits, rendered as 16 hex chars. Chosen over an average hash
# because a screen that scrolled a few pixels changes a dHash while an average hash can stay
# identical -- and a false "unchanged" is the failure that would silently drop real activity.
#
# The grid arrives from the capture child, which resamples with System.Drawing. Decoding a full
# 1080p PNG in pure Python would cost seconds of CPU per frame for a decision that must be cheap.
# Consequence: this hash is only ever compared against the previous frame from the same device, so
# it does not need to be bit-compatible with any other client's.
W = 9
H = 8

# Frames within this many differing bits count as the same screen. Deliberately 0: "identical" is
# the claim the notice makes to the device user, and a tolerant threshold quietly widens what the
# agent decides not to upload.
UNCHANGED_THRESHOLD = 0


def dhash(cells):
    if not cells or len(cells) != W * H:
        return None
    bits = 0
    for y in range(H):
        for x in range(W - 1):
            bits = (bits << 1) | (1 if cells[y * W + x] < cells[y * W + x + 1] else 0)
    return f"{bits:016x}"


def hamming(hex_a, hex_b):
    try:
        return (int(hex_a, 16) ^ int(hex_b, 16)).bit_count()
    except (TypeError, ValueError):
        return math.inf


def is_unchanged(prev_hex, next_hex, threshold=UNCHANGED_THRESHOLD):
    if not prev_hex or not next_hex:
        return False
    return hamming(prev_hex, next_hex) <= threshold
