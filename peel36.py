"""Bit-exact Python port of fountain.js's assemble() for the field36 pooled peel.
The browser route died mid-validation (pane classifier); the peel is pure
deterministic arithmetic, so it moves offline. mulberry32 replicated under
uint32 masking; rng() doubles are IEEE-exact in both runtimes."""
import math

M32 = 0xFFFFFFFF

def mulberry32(seed):
    a = seed & M32
    def rng():
        nonlocal a
        a = (a + 0x6D2B79F5) & M32
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & M32
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & M32)) & M32
        t &= M32
        return ((t ^ (t >> 14)) & M32) / 4294967296.0
    return rng

def subset_for(ring_seed, c, K):
    if 1 <= c <= min(3, K):
        return [c - 1]
    rng = mulberry32(((ring_seed * 2654435761) ^ (c * 40503)) & M32)
    r = rng()
    if r < 0.12: d = 1
    elif r < 0.55: d = 2
    elif r < 0.80: d = 3
    elif r < 0.93: d = 4
    else: d = min(8, K)
    d = min(d, K)
    pool = list(range(K))
    out = []
    for j in range(d):
        pick = j + math.floor(rng() * (K - j))
        pool[j], pool[pick] = pool[pick], pool[j]
        out.append(pool[j])
    return out

DATA_BYTES = 5  # droplet_bits 48 = 40 data + 8 CRC
HEADER_EVERY = 8

SEG1 = {
    101: [(0,"a719007d55"),(1,"2248656c6c"),(2,"6f21205468"),(4,"0a15494443"),(8,"a719007d55"),
          (9,"4d3c0d1e1d"),(10,"6478353771"),(11,"450a1a5312"),(12,"637420636f"),(13,"1d1e11405c"),
          (14,"7837662667"),(20,"64723c6321"),(21,"170d075a47"),(22,"4b3a4e1f06"),(23,"463549214e"),
          (24,"a719007d55"),(25,"1d1441130d")],
    202: [(0,"a719007d55"),(1,"2248656c6c"),(5,"47680d1902"),(6,"114f5c0452"),(7,"4549165816"),
          (8,"a719007d55"),(9,"1741060c04"),(10,"1a4f54740e"),(13,"171753424d"),(15,"0706490317"),
          (16,"a719007d55"),(17,"7464697c65"),(18,"6e3237772a")],
    303: [(0,"a719007d55"),(1,"2248656c6c"),(4,"6037372769"),(5,"070645074f"),(6,"1606000d0a"),
          (9,"6e672c2063"),(10,"7261637465"),(11,"0146002000"),(12,"6564732e22")],
}
SEG2 = {
    101: [(24,"a719007d55"),(25,"1d1441130d"),(26,"5f1d4f1659"),(31,"0d060a180c"),(32,"a719007d55"),
          (33,"75292c6f25"),(34,"1c44104643"),(35,"6520657861"),(36,"0a011f1650"),(37,"1749110c04"),
          (43,"7972244b6c"),(44,"0b00451d4f"),(45,"1c0e54000d"),(46,"1f494d030f"),(47,"6472656420"),
          (48,"a719007d55")],
    202: [],
    303: [(12,"6564732e22"),(13,"0d59584213"),(15,"6537730325"),(16,"a719007d55"),(17,"1d5c554548"),
          (18,"7261637465"),(21,"0c0200041a"),(22,"121a166111"),(23,"1b16020c0c")],
}

header = None
lt = []
seen = set()
for seg in (SEG1, SEG2):
    for seed, drops in seg.items():
        for c, hx in drops:
            b = bytes.fromhex(hx)
            if c % HEADER_EVERY == 0:
                if header is None and b[0] == 0xA7 and b[1] >= 1:
                    ln = (b[2] << 8) | b[3]
                    header = {"K": b[1], "len": ln, "pcrc": b[4]}
            else:
                key = (seed, c)
                if key not in seen:
                    seen.add(key)
                    lt.append((seed, c, bytearray(b)))

assert header, "no header droplet"
K = header["K"]
drops = [{"sub": subset_for(seed, c, K), "bytes": bytearray(b[:DATA_BYTES])} for seed, c, b in lt]
blocks = [None] * K
recovered = 0
progress = True
while progress:
    progress = False
    for dr in drops:
        if dr["sub"] is None:
            continue
        unknown = []
        for bi in dr["sub"]:
            if blocks[bi] is not None:
                for j in range(DATA_BYTES):
                    dr["bytes"][j] ^= blocks[bi][j]
            else:
                unknown.append(bi)
        dr["sub"] = unknown
        if len(unknown) == 1:
            blocks[unknown[0]] = bytes(dr["bytes"])
            recovered += 1
            dr["sub"] = None
            progress = True
        elif len(unknown) == 0:
            dr["sub"] = None

print(f"header K={K} len={header['len']} | uniques={len(lt)} | recovered={recovered}/{K}")
if recovered == K:
    out = b"".join(blocks)[: header["len"]]
    text = "".join(chr(c) if 32 <= c < 127 else ("" if c == 0 else f"\\x{c:02x}") for c in out)
    print("TEXT:", repr(text))
else:
    missing = [i for i in range(K) if blocks[i] is None]
    print("peel incomplete; missing blocks:", missing)
