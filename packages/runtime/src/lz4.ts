/**
 * LZ4 block 格式解压（无依赖 TS 实现，对应 C 的 LZ4_decompress_safe）。
 * WE 的 .tex 用 block 压缩（非 frame 格式），无魔数、无校验和。
 */

export function lz4Decompress(src: Uint8Array, decompressedSize: number): Uint8Array {
    const dst = new Uint8Array(decompressedSize)
    let s = 0
    let d = 0

    while (s < src.length) {
        const token = src[s++]!

        // 字面量长度（高 4 位，15 表示有扩展字节）
        let litLen = token >> 4
        if (litLen === 15) {
            let b: number
            do {
                b = src[s++]!
                litLen += b
            } while (b === 255)
        }
        for (let i = 0; i < litLen; i++) dst[d++] = src[s++]!

        if (s >= src.length) break // 最后一个序列只有字面量

        // 匹配偏移（2 字节 LE）
        const offset = src[s]! | src[s + 1]! << 8
        s += 2
        if (offset === 0 || offset > d) throw new Error(`lz4: 非法匹配偏移 ${offset}（dst 位置 ${d}）`)

        // 匹配长度（低 4 位 + 4，15 表示有扩展字节）
        let matchLen = token & 0xf
        if (matchLen === 15) {
            let b: number
            do {
                b = src[s++]!
                matchLen += b
            } while (b === 255)
        }
        matchLen += 4

        // 源与目标可重叠（原地重复填充）
        let p = d - offset
        for (let i = 0; i < matchLen; i++) dst[d++] = dst[p++]!
    }

    if (d !== decompressedSize) throw new Error(`lz4: 解压长度不符（${d} != ${decompressedSize}）`)

    return dst
}
