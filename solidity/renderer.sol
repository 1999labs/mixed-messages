// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Renderer
/// @notice Salt-cuts renderer for Mixed Messages 1/1 art. Three-phase algorithm:
///   1. SCATTERED BASE — each submission picks a region either randomly
///      (BASE_SCATTER_PROB%) or by closeness, decided by a PRNG flip seeded
///      by the prompt. Submission's quadrant determines paint color,
///      magnitude drives the claim share, per-axis magnitude determines cut
///      direction: P(vertical) = |x-0.5| / (|x-0.5|+|y-0.5|).
///   2. FULL-COVERAGE LANDLOCK — every remaining white region is recolored
///      via a count-weighted picker with the local region's matching color
///      discounted to 30% weight.
///   3. SALT POST-PASS — K tiny boxes are added at prompt-seeded random
///      positions. Each is a double-cut producing a small rect at one
///      corner of a randomly-chosen region. Salt color uses the same
///      count-weighted + locally-discounted picker as landlock.
///
/// Submissions are reordered by a deterministic Fisher-Yates shuffle seeded
/// by the prompt so first-mover doesn't dominate. Painted regions are
/// blended toward white at a flat alpha for a printed look.
///
/// Must produce identical output to renderer/recursivesubdivision.js (JS
/// reference) and frontend/src/components/ContourRenderer.tsx (preview).
contract Renderer {
    uint256 private constant SCALE = 10000;
    uint256 private constant COORD_SCALE = 10000;
    uint256 private constant MIN_DIM = 50;
    uint256 private constant NOISE_RANGE = 1000;
    uint256 private constant FLAT_ALPHA = 95;
    uint256 private constant BG_R = 0xff;
    uint256 private constant BG_G = 0xff;
    uint256 private constant BG_B = 0xff;

    // Tuned project defaults (match renderer/recursivesubdivision.js)
    uint256 private constant DENSITY_MULT = 10;
    uint256 private constant MAX_SLIVER_PCT = 30;
    // Conviction-axis bias hardcoded on. Legacy axis rule is intentionally
    // omitted — JS keeps it only as a toggle for the test playground.

    uint256 private constant SALT_K_CAP = 300;
    uint256 private constant BASE_SCATTER_PROB = 20; // /100
    uint256 private constant LOCAL_Q_DISCOUNT_NUM = 3;
    uint256 private constant LOCAL_Q_DISCOUNT_DEN = 10;
    uint256 private constant SLIVER_MIN = 100;

    struct Region {
        uint32 x;
        uint32 y;
        uint32 w;
        uint32 h;
        uint8 cr;
        uint8 cg;
        uint8 cb;
    }

    /// @notice Render the 1/1 SVG from response coordinates and prompt.
    /// @param xs       per-submission x in [0, COORD_SCALE]
    /// @param ys       per-submission y in [0, COORD_SCALE]
    /// @param prompt   day's word — seeds the PRNG so output is deterministic
    function renderSVG(
        uint16[] calldata xs,
        uint16[] calldata ys,
        string calldata prompt
    ) external pure returns (string memory) {
        require(xs.length == ys.length, "Length mismatch");
        uint256 n = xs.length;

        if (n == 0) {
            return _emitBlankSVG();
        }

        // Salt count K = min(cap, ceil(DENSITY_MULT * 120 / (20 + isqrt(N))))
        uint256 K = _computeK(n);

        // Max regions: 1 initial + n base cuts (+1 each) + K salt cuts (+2 each)
        uint256 maxRegions = 1 + n + 2 * K;
        Region[] memory regions = new Region[](maxRegions);
        regions[0].x = 0;
        regions[0].y = 0;
        regions[0].w = uint32(SCALE);
        regions[0].h = uint32(SCALE);
        regions[0].cr = 0xff;
        regions[0].cg = 0xff;
        regions[0].cb = 0xff;
        uint256 count = 1;

        // Per-quadrant counts → color weights for landlock + salt
        uint256[4] memory baseWeights = _countQuadrants(xs, ys);

        // RNG streams: base/shuffle = fnv1a32(prompt); salt = fnv1a32(prompt || '\x00salt')
        uint32 promptHash = fnv1a32(bytes(prompt));
        uint32 baseRng = promptHash;
        uint32 saltRng = _saltSeed(prompt);

        // Fisher-Yates shuffle (independent stream so cut rng isn't disturbed)
        uint256[] memory order = _shuffledOrder(n, promptHash);

        // === BASE LAYER ===
        for (uint256 i; i < n;) {
            uint256 idx = order[i];
            (count, baseRng) = _processBaseCut(
                regions,
                count,
                baseRng,
                uint256(xs[idx]),
                uint256(ys[idx])
            );
            unchecked { ++i; }
        }

        // === LANDLOCK (full coverage) ===
        baseRng = _landlock(regions, count, baseWeights, baseRng);

        // === SALT POST-PASS ===
        for (uint256 k; k < K;) {
            uint256 newCount;
            uint32 newRng;
            bool ok;
            (newCount, newRng, ok) = _processSaltCut(regions, count, saltRng, baseWeights);
            if (!ok) break; // no cuttable regions left
            count = newCount;
            saltRng = newRng;
            unchecked { ++k; }
        }

        return _emitSVG(regions, count);
    }

    /// @notice Individual participant SVG: colored quadrant grid with all
    /// dots, owner highlighted. Unchanged from previous renderer; used by
    /// per-token participant views.
    function renderIndividualSVG(
        uint16[] calldata xs,
        uint16[] calldata ys,
        uint256 ownerIndex
    ) external pure returns (string memory) {
        require(xs.length == ys.length, "Length mismatch");
        uint256 n = xs.length;

        bytes memory buf = new bytes(100000);
        uint256 p = 0;

        p = _writeStr(buf, p, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" shape-rendering="crispEdges">');
        p = _writeStr(buf, p, '<rect x="0" y="0" width="200" height="200" fill="rgb(85,255,255)"/>');
        p = _writeStr(buf, p, '<rect x="200" y="0" width="200" height="200" fill="rgb(85,255,85)"/>');
        p = _writeStr(buf, p, '<rect x="0" y="200" width="200" height="200" fill="rgb(255,85,85)"/>');
        p = _writeStr(buf, p, '<rect x="200" y="200" width="200" height="200" fill="rgb(85,85,255)"/>');
        p = _writeStr(buf, p, '<line x1="200" y1="0" x2="200" y2="400" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>');
        p = _writeStr(buf, p, '<line x1="0" y1="200" x2="400" y2="200" stroke="rgba(0,0,0,0.15)" stroke-width="1"/>');
        p = _writeStr(buf, p, '<rect x=".5" y=".5" width="399" height="399" fill="none" stroke="rgba(0,0,0,0.25)" stroke-width="1"/>');

        for (uint256 i; i < n;) {
            uint256 px = uint256(xs[i]) * 400 / COORD_SCALE;
            uint256 py = uint256(ys[i]) * 400 / COORD_SCALE;

            if (i == ownerIndex) {
                uint256 dx = px >= 5 ? px - 5 : 0;
                uint256 dy = py >= 5 ? py - 5 : 0;
                p = _writeStr(buf, p, '<rect x="');
                p = _writeUint(buf, p, dx);
                p = _writeStr(buf, p, '" y="');
                p = _writeUint(buf, p, dy);
                p = _writeStr(buf, p, '" width="10" height="10" fill="rgba(0,0,0,0.85)"/>');
            } else {
                uint256 dx = px >= 4 ? px - 4 : 0;
                uint256 dy = py >= 4 ? py - 4 : 0;
                p = _writeStr(buf, p, '<rect x="');
                p = _writeUint(buf, p, dx);
                p = _writeStr(buf, p, '" y="');
                p = _writeUint(buf, p, dy);
                p = _writeStr(buf, p, '" width="8" height="8" fill="rgba(0,0,0,0.25)"/>');
            }
            unchecked { ++i; }
        }

        p = _writeStr(buf, p, '</svg>');
        assembly { mstore(buf, p) }
        return string(buf);
    }

    // ========== Setup helpers ==========

    function _computeK(uint256 n) private pure returns (uint256) {
        uint256 sqrtN = _isqrt(n);
        uint256 denom = 20 + sqrtN;
        // ceil(DENSITY_MULT * 120 / denom) = (DENSITY_MULT * 120 + denom - 1) / denom
        uint256 K = (DENSITY_MULT * 120 + denom - 1) / denom;
        return K > SALT_K_CAP ? SALT_K_CAP : K;
    }

    function _emitBlankSVG() private pure returns (string memory) {
        return string(
            abi.encodePacked(
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 10000" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">',
                '<rect width="10000" height="10000" fill="rgb(255,255,255)"/>',
                '</svg>'
            )
        );
    }

    function _countQuadrants(uint16[] calldata xs, uint16[] calldata ys)
        private pure
        returns (uint256[4] memory weights)
    {
        uint256 half = SCALE / 2;
        uint256[4] memory counts;
        uint256 n = xs.length;
        for (uint256 i; i < n;) {
            uint256 qi = (uint256(ys[i]) < half ? 0 : 2) + (uint256(xs[i]) < half ? 0 : 1);
            unchecked { ++counts[qi]; ++i; }
        }
        // +1 floor per quadrant so unanimous-quadrant days don't collapse to a
        // single color in landlock/salt. Matches recursivesubdivision.js.
        weights[0] = counts[0] + 1;
        weights[1] = counts[1] + 1;
        weights[2] = counts[2] + 1;
        weights[3] = counts[3] + 1;
    }

    function _saltSeed(string memory prompt) private pure returns (uint32) {
        // Hash of (prompt || '\x00salt'). Mirrors JS:
        //   fnv1a32((prompt || '') + '\x00salt')
        return fnv1a32(abi.encodePacked(bytes(prompt), bytes("\x00salt")));
    }

    function _shuffledOrder(uint256 n, uint32 promptHash)
        private pure
        returns (uint256[] memory order)
    {
        order = new uint256[](n);
        for (uint256 i; i < n;) {
            order[i] = i;
            unchecked { ++i; }
        }
        uint32 shuffleRng = promptHash;
        for (uint256 i = n; i > 1;) {
            unchecked { --i; }
            shuffleRng = next32(shuffleRng);
            uint256 j = uint256(shuffleRng) % (i + 1);
            if (j != i) {
                (order[i], order[j]) = (order[j], order[i]);
            }
        }
    }

    // ========== Base cut ==========

    function _processBaseCut(
        Region[] memory regions,
        uint256 count,
        uint32 rng,
        uint256 px,
        uint256 py
    ) private pure returns (uint256, uint32) {
        if (px > SCALE) px = SCALE;
        if (py > SCALE) py = SCALE;

        // Decide scatter vs closest (advance rng exactly once)
        rng = next32(rng);
        bool useScatter = (uint256(rng) % 100) < BASE_SCATTER_PROB;

        int256 bestIdx;
        if (useScatter) {
            (bestIdx, rng) = _pickRegionScatter(regions, count, rng);
        } else {
            bestIdx = _pickRegionClosest(regions, count, px, py);
        }
        if (bestIdx < 0) return (count, rng);
        uint256 idx = uint256(bestIdx);

        // Compute cut params; helper advances rng twice (axis + paintLow), then
        // _applyBaseCut advances it once more for noise.
        return _applyBaseCut(regions, count, idx, rng, px, py);
    }

    function _applyBaseCut(
        Region[] memory regions,
        uint256 count,
        uint256 idx,
        uint32 rng,
        uint256 px,
        uint256 py
    ) private pure returns (uint256, uint32) {
        // Cut direction via conviction-axis (advances rng once)
        bool splitWidth;
        (splitWidth, rng) = _convictionAxis(regions[idx], px, py, rng);

        // Claim share + paintLow (advances rng once)
        uint256 claimedShare = _sliceClaimScaled(px, py);
        rng = next32(rng);
        bool paintLow = (uint256(rng) & 1) == 0;
        uint256 baseRatio = paintLow ? claimedShare : (SCALE - claimedShare);

        // Noise + clamp (advances rng once)
        rng = next32(rng);
        int256 noise = int256(uint256(rng) % (NOISE_RANGE + 1)) - int256(NOISE_RANGE / 2);
        int256 ratio = int256(baseRatio) + noise;
        if (ratio < 1500) ratio = 1500;
        if (ratio > 8500) ratio = 8500;

        // Build child regions and splice in
        Region memory reg = regions[idx];
        uint256 dim = splitWidth ? uint256(reg.w) : uint256(reg.h);
        uint256 cutPos = dim * uint256(ratio) / SCALE;
        if (cutPos < MIN_DIM) cutPos = MIN_DIM;
        if (cutPos > dim - MIN_DIM) cutPos = dim - MIN_DIM;

        (Region memory r1, Region memory r2) = _buildBaseChildren(reg, splitWidth, cutPos, paintLow, px, py);

        // Splice in: replaces regions[idx] with r1, inserts r2 at idx+1 (shift right)
        count = _splice2(regions, count, idx, r1, r2);
        return (count, rng);
    }

    function _convictionAxis(
        Region memory reg,
        uint256 px,
        uint256 py,
        uint32 rng
    ) private pure returns (bool splitWidth, uint32 newRng) {
        // P(vertical) = |2px - SCALE| / (|2px - SCALE| + |2py - SCALE|).
        // splitWidth=true means a vertical cut.
        uint256 xMag = px * 2 >= SCALE ? px * 2 - SCALE : SCALE - px * 2;
        uint256 yMag = py * 2 >= SCALE ? py * 2 - SCALE : SCALE - py * 2;
        uint256 totalMag = xMag + yMag;
        newRng = next32(rng);
        if (totalMag == 0) {
            splitWidth = (uint256(newRng) & 1) == 0;
        } else {
            uint256 pVertScaled = xMag * SCALE / totalMag;
            splitWidth = (uint256(newRng) % SCALE) < pVertScaled;
        }
        // Fallback if chosen axis is too narrow
        if (splitWidth && reg.w < 2 * MIN_DIM) splitWidth = false;
        else if (!splitWidth && reg.h < 2 * MIN_DIM) splitWidth = true;
    }

    function _buildBaseChildren(
        Region memory reg,
        bool splitWidth,
        uint256 cutPos,
        bool paintLow,
        uint256 px,
        uint256 py
    ) private pure returns (Region memory r1, Region memory r2) {
        if (splitWidth) {
            r1.x = reg.x;                              r1.y = reg.y;
            r1.w = uint32(cutPos);                     r1.h = reg.h;
            r2.x = uint32(uint256(reg.x) + cutPos);    r2.y = reg.y;
            r2.w = uint32(uint256(reg.w) - cutPos);    r2.h = reg.h;
        } else {
            r1.x = reg.x;                              r1.y = reg.y;
            r1.w = reg.w;                              r1.h = uint32(cutPos);
            r2.x = reg.x;                              r2.y = uint32(uint256(reg.y) + cutPos);
            r2.w = reg.w;                              r2.h = uint32(uint256(reg.h) - cutPos);
        }
        (uint8 ncR, uint8 ncG, uint8 ncB) = _discreteColor(px, py);
        if (paintLow) {
            r1.cr = ncR;    r1.cg = ncG;    r1.cb = ncB;
            r2.cr = reg.cr; r2.cg = reg.cg; r2.cb = reg.cb;
        } else {
            r2.cr = ncR;    r2.cg = ncG;    r2.cb = ncB;
            r1.cr = reg.cr; r1.cg = reg.cg; r1.cb = reg.cb;
        }
    }

    // ========== Landlock (full coverage) ==========

    function _landlock(
        Region[] memory regions,
        uint256 count,
        uint256[4] memory baseWeights,
        uint32 rng
    ) private pure returns (uint32) {
        for (uint256 i; i < count;) {
            Region memory reg = regions[i];
            bool isWhite = reg.cr == 0xff && reg.cg == 0xff && reg.cb == 0xff;
            if (isWhite) {
                uint256 cx = uint256(reg.x) + uint256(reg.w) / 2;
                uint256 cy = uint256(reg.y) + uint256(reg.h) / 2;
                uint256 localQ = (cy < SCALE / 2 ? 0 : 2) + (cx < SCALE / 2 ? 0 : 1);
                uint8 nr; uint8 ng; uint8 nb;
                (nr, ng, nb, rng) = _pickWeightedColor(baseWeights, localQ, rng);
                regions[i].cr = nr;
                regions[i].cg = ng;
                regions[i].cb = nb;
            }
            unchecked { ++i; }
        }
        return rng;
    }

    // ========== Salt ==========

    function _processSaltCut(
        Region[] memory regions,
        uint256 count,
        uint32 rng,
        uint256[4] memory baseWeights
    ) private pure returns (uint256, uint32, bool) {
        // Pick region area-weighted
        int256 bestIdx;
        (bestIdx, rng) = _pickRegionScatter(regions, count, rng);
        if (bestIdx < 0) return (count, rng, false);
        uint256 idx = uint256(bestIdx);

        // First cut: random axis (fallback if forbidden), edge-biased position
        rng = next32(rng);
        bool splitWidth1 = (uint256(rng) & 1) == 0;
        {
            Region memory reg0 = regions[idx];
            if (splitWidth1 && reg0.w < 2 * MIN_DIM) splitWidth1 = false;
            else if (!splitWidth1 && reg0.h < 2 * MIN_DIM) splitWidth1 = true;
        }

        uint256 cutPos1;
        bool nearLow1;
        (cutPos1, nearLow1, rng) = _saltCutPos(splitWidth1 ? uint256(regions[idx].w) : uint256(regions[idx].h), rng);

        // Split into sliver + remainder (sliver is the smaller piece)
        (Region memory sliver, Region memory remainder) = _saltSplitFirst(regions[idx], splitWidth1, cutPos1, nearLow1);

        // Pick salt color (count-weighted + local discount on the parent region's quadrant)
        uint256 localQ;
        {
            Region memory reg0 = regions[idx];
            uint256 regCx = uint256(reg0.x) + uint256(reg0.w) / 2;
            uint256 regCy = uint256(reg0.y) + uint256(reg0.h) / 2;
            localQ = (regCy < SCALE / 2 ? 0 : 2) + (regCx < SCALE / 2 ? 0 : 1);
        }
        uint8 ncR; uint8 ncG; uint8 ncB;
        (ncR, ncG, ncB, rng) = _pickWeightedColor(baseWeights, localQ, rng);

        // Second cut: perpendicular to the first. Turns the strip into a small box.
        // Fallback: if sliver too narrow, paint the whole strip.
        bool splitWidth2 = !splitWidth1;
        uint256 dim2 = splitWidth2 ? uint256(sliver.w) : uint256(sliver.h);
        if (dim2 < 2 * MIN_DIM) {
            sliver.cr = ncR; sliver.cg = ncG; sliver.cb = ncB;
            count = _splice2(regions, count, idx, sliver, remainder);
        } else {
            uint256 cutPos2;
            bool nearLow2;
            (cutPos2, nearLow2, rng) = _saltCutPos(dim2, rng);
            (Region memory tinyBox, Region memory sliverRest) =
                _saltSplitSecond(sliver, splitWidth2, cutPos2, nearLow2, ncR, ncG, ncB);
            count = _splice3(regions, count, idx, tinyBox, sliverRest, remainder);
        }
        return (count, rng, true);
    }

    /// @dev Edge-biased cut position. Returns (cutPos, nearLow, newRng).
    /// Sliver lives on the low side when nearLow=true, else high side.
    function _saltCutPos(uint256 dim, uint32 rng)
        private pure
        returns (uint256 cutPos, bool nearLow, uint32 newRng)
    {
        uint256 sliverMaxU = MAX_SLIVER_PCT * 100;
        if (sliverMaxU < SLIVER_MIN + 1) sliverMaxU = SLIVER_MIN + 1;
        uint256 sliverSpan = sliverMaxU - SLIVER_MIN + 1;

        newRng = next32(rng);
        nearLow = (uint256(newRng) & 1) == 0;
        newRng = next32(newRng);
        uint256 ratio = nearLow
            ? SLIVER_MIN + (uint256(newRng) % sliverSpan)
            : (SCALE - sliverMaxU) + (uint256(newRng) % sliverSpan);

        cutPos = dim * ratio / SCALE;
        if (cutPos < MIN_DIM) cutPos = MIN_DIM;
        if (cutPos > dim - MIN_DIM) cutPos = dim - MIN_DIM;
    }

    function _saltSplitFirst(
        Region memory reg,
        bool splitWidth,
        uint256 cutPos,
        bool nearLow
    ) private pure returns (Region memory sliver, Region memory remainder) {
        // Both child regions inherit parent color initially
        Region memory a;
        Region memory b;
        if (splitWidth) {
            a.x = reg.x;                            a.y = reg.y;
            a.w = uint32(cutPos);                   a.h = reg.h;
            b.x = uint32(uint256(reg.x) + cutPos);  b.y = reg.y;
            b.w = uint32(uint256(reg.w) - cutPos);  b.h = reg.h;
        } else {
            a.x = reg.x;                            a.y = reg.y;
            a.w = reg.w;                            a.h = uint32(cutPos);
            b.x = reg.x;                            b.y = uint32(uint256(reg.y) + cutPos);
            b.w = reg.w;                            b.h = uint32(uint256(reg.h) - cutPos);
        }
        a.cr = reg.cr; a.cg = reg.cg; a.cb = reg.cb;
        b.cr = reg.cr; b.cg = reg.cg; b.cb = reg.cb;
        sliver    = nearLow ? a : b;
        remainder = nearLow ? b : a;
    }

    function _saltSplitSecond(
        Region memory sliver,
        bool splitWidth,
        uint256 cutPos,
        bool nearLow,
        uint8 ncR,
        uint8 ncG,
        uint8 ncB
    ) private pure returns (Region memory tinyBox, Region memory sliverRest) {
        Region memory a;
        Region memory b;
        if (splitWidth) {
            a.x = sliver.x;                              a.y = sliver.y;
            a.w = uint32(cutPos);                        a.h = sliver.h;
            b.x = uint32(uint256(sliver.x) + cutPos);    b.y = sliver.y;
            b.w = uint32(uint256(sliver.w) - cutPos);    b.h = sliver.h;
        } else {
            a.x = sliver.x;                              a.y = sliver.y;
            a.w = sliver.w;                              a.h = uint32(cutPos);
            b.x = sliver.x;                              b.y = uint32(uint256(sliver.y) + cutPos);
            b.w = sliver.w;                              b.h = uint32(uint256(sliver.h) - cutPos);
        }
        // Both initially inherit sliver's color
        a.cr = sliver.cr; a.cg = sliver.cg; a.cb = sliver.cb;
        b.cr = sliver.cr; b.cg = sliver.cg; b.cb = sliver.cb;
        tinyBox    = nearLow ? a : b;
        sliverRest = nearLow ? b : a;
        tinyBox.cr = ncR; tinyBox.cg = ncG; tinyBox.cb = ncB;
    }

    // ========== Region pickers ==========

    /// @dev Closest-region selection by squared distance. Returns -1 if none.
    function _pickRegionClosest(
        Region[] memory regions,
        uint256 count,
        uint256 px,
        uint256 py
    ) private pure returns (int256 bestIdx) {
        bestIdx = -1;
        int256 bestScore = 0;
        for (uint256 i; i < count;) {
            Region memory reg = regions[i];
            if (reg.w < 2 * MIN_DIM && reg.h < 2 * MIN_DIM) {
                unchecked { ++i; }
                continue;
            }
            int256 cx = int256(uint256(reg.x) + uint256(reg.w) / 2);
            int256 cy = int256(uint256(reg.y) + uint256(reg.h) / 2);
            int256 dx = cx - int256(px);
            int256 dy = cy - int256(py);
            int256 score = dx * dx + dy * dy;
            if (bestIdx < 0 || score < bestScore) {
                bestScore = score;
                bestIdx = int256(i);
            }
            unchecked { ++i; }
        }
    }

    /// @dev Area-weighted random region selection. Advances rng once.
    /// Mirrors JS: target = rng % totalArea; pick smallest idx where
    /// cumulative area > target.
    function _pickRegionScatter(
        Region[] memory regions,
        uint256 count,
        uint32 rng
    ) private pure returns (int256 bestIdx, uint32 newRng) {
        // First pass: total area
        uint256 totalArea;
        for (uint256 i; i < count;) {
            Region memory reg = regions[i];
            if (reg.w >= 2 * MIN_DIM || reg.h >= 2 * MIN_DIM) {
                totalArea += uint256(reg.w) * uint256(reg.h);
            }
            unchecked { ++i; }
        }
        if (totalArea == 0) return (-1, rng);

        newRng = next32(rng);
        uint256 target = uint256(newRng) % totalArea;

        // Second pass: find region whose cumulative area first exceeds target
        uint256 cum;
        for (uint256 i; i < count;) {
            Region memory reg = regions[i];
            if (reg.w >= 2 * MIN_DIM || reg.h >= 2 * MIN_DIM) {
                cum += uint256(reg.w) * uint256(reg.h);
                if (cum > target) return (int256(i), newRng);
            }
            unchecked { ++i; }
        }
        // Unreachable (target < totalArea), but satisfy compiler
        return (int256(count) - 1, newRng);
    }

    // ========== Splice (matches JS Array.splice insertion order) ==========

    /// @dev Replace regions[idx] with `a`, insert `b` at idx+1 (shifting right).
    /// Returns the new count.
    function _splice2(
        Region[] memory regions,
        uint256 count,
        uint256 idx,
        Region memory a,
        Region memory b
    ) private pure returns (uint256) {
        // Shift regions[idx+1 .. count-1] right by 1 into [idx+2 .. count].
        // Assign first, then decrement — otherwise the final destination slot
        // (regions[count]) is never written and the tail element is lost.
        for (uint256 i = count; i > idx + 1;) {
            regions[i] = regions[i - 1];
            unchecked { --i; }
        }
        regions[idx] = a;
        regions[idx + 1] = b;
        return count + 1;
    }

    /// @dev Replace regions[idx] with `a`, insert `b` at idx+1, `c` at idx+2
    /// (shifting all subsequent regions right by 2).
    function _splice3(
        Region[] memory regions,
        uint256 count,
        uint256 idx,
        Region memory a,
        Region memory b,
        Region memory c
    ) private pure returns (uint256) {
        // Shift regions[idx+1 .. count-1] right by 2 into [idx+3 .. count+1].
        // Assign first, then decrement — otherwise the final destination slot
        // (regions[count+1]) is never written and the tail element is lost.
        for (uint256 i = count + 1; i > idx + 2;) {
            regions[i] = regions[i - 2];
            unchecked { --i; }
        }
        regions[idx] = a;
        regions[idx + 1] = b;
        regions[idx + 2] = c;
        return count + 2;
    }

    // ========== Color picker ==========

    /// @dev Count-weighted color sampler with the local quadrant's matching
    /// color discounted to LOCAL_Q_DISCOUNT_NUM/LOCAL_Q_DISCOUNT_DEN of its
    /// weight. Advances rng once. Falls back to uniform if all weights
    /// discount to zero (e.g., single-quadrant input with localQ == that
    /// quadrant).
    function _pickWeightedColor(
        uint256[4] memory baseWeights,
        uint256 localQ,
        uint32 rng
    ) private pure returns (uint8, uint8, uint8, uint32 newRng) {
        uint256[4] memory w;
        w[0] = baseWeights[0]; w[1] = baseWeights[1];
        w[2] = baseWeights[2]; w[3] = baseWeights[3];
        w[localQ] = w[localQ] * LOCAL_Q_DISCOUNT_NUM / LOCAL_Q_DISCOUNT_DEN;
        uint256 total = w[0] + w[1] + w[2] + w[3];
        newRng = next32(rng);
        uint256 t;
        if (total == 0) {
            t = uint256(newRng) % 4;
            (uint8 r0, uint8 g0, uint8 b0) = _colorForIndex(t);
            return (r0, g0, b0, newRng);
        }
        t = uint256(newRng) % total;
        uint256 idx;
        if (t < w[0]) idx = 0;
        else if (t < w[0] + w[1]) idx = 1;
        else if (t < w[0] + w[1] + w[2]) idx = 2;
        else idx = 3;
        (uint8 r, uint8 g, uint8 b) = _colorForIndex(idx);
        return (r, g, b, newRng);
    }

    function _colorForIndex(uint256 idx) private pure returns (uint8, uint8, uint8) {
        if (idx == 0) return (85, 255, 255);   // TL — cyan
        if (idx == 1) return (85, 255, 85);    // TR — green
        if (idx == 2) return (255, 85, 85);    // BL — red
        return (85, 85, 255);                  // BR — blue
    }

    // ========== PRNG (must match JS reference exactly) ==========

    function fnv1a32(bytes memory data) internal pure returns (uint32 h) {
        h = 0x811c9dc5;
        unchecked {
            for (uint256 i = 0; i < data.length; i++) {
                h ^= uint32(uint8(data[i]));
                h = uint32(uint256(h) * 0x01000193);
            }
        }
    }

    function next32(uint32 state) internal pure returns (uint32) {
        unchecked {
            return uint32(uint256(state) * 1664525 + 1013904223);
        }
    }

    // ========== Color / claim helpers ==========

    // Discrete color by grid quadrant. px, py are in [0, SCALE].
    //   TL (uniting  + performed) → cyan  (85,255,255)
    //   TR (uniting  + honest)    → green (85,255,85)
    //   BL (dividing + performed) → red   (255,85,85)
    //   BR (dividing + honest)    → blue  (85,85,255)
    function _discreteColor(uint256 px, uint256 py)
        private pure
        returns (uint8 r, uint8 g, uint8 b)
    {
        uint256 half = SCALE / 2;
        if (px < half && py < half) return (85, 255, 255);
        if (px >= half && py < half) return (85, 255, 85);
        if (px < half && py >= half) return (255, 85, 85);
        return (85, 85, 255);
    }

    function _blendChannel(uint8 ch, uint256 bg) private pure returns (uint8) {
        return uint8((uint256(ch) * FLAT_ALPHA + bg * (100 - FLAT_ALPHA)) / 100);
    }

    function _sliceClaimScaled(uint256 px, uint256 py) private pure returns (uint256) {
        uint256 half = SCALE / 2;
        uint256 dx2 = (px > half ? px - half : half - px) * 2;
        uint256 dy2 = (py > half ? py - half : half - py) * 2;
        uint256 magScaled = dx2 > dy2 ? dx2 : dy2;
        uint256 shapedScaled = _isqrt(magScaled * SCALE);
        return half + shapedScaled * 20 / 100;
    }

    function _isqrt(uint256 x) private pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    // ========== SVG emission ==========

    function _emitSVG(Region[] memory regions, uint256 count)
        private pure
        returns (string memory)
    {
        bytes memory buf = new bytes(256000);
        uint256 p = 0;

        p = _writeStr(buf, p, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10000 10000" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges">');
        p = _writeStr(buf, p, '<rect width="10000" height="10000" fill="rgb(255,255,255)"/>');

        for (uint256 i; i < count;) {
            Region memory reg = regions[i];
            uint8 r = _blendChannel(reg.cr, BG_R);
            uint8 g = _blendChannel(reg.cg, BG_G);
            uint8 b = _blendChannel(reg.cb, BG_B);
            p = _writeRect(buf, p, reg.x, reg.y, reg.w, reg.h, r, g, b);
            unchecked { ++i; }
        }

        p = _writeStr(buf, p, '</svg>');

        assembly { mstore(buf, p) }
        return string(buf);
    }

    function _writeRect(
        bytes memory buf,
        uint256 p,
        uint32 x,
        uint32 y,
        uint32 w,
        uint32 h,
        uint8 r,
        uint8 g,
        uint8 b
    ) private pure returns (uint256) {
        p = _writeStr(buf, p, '<rect x="');
        p = _writeUint(buf, p, uint256(x));
        p = _writeStr(buf, p, '" y="');
        p = _writeUint(buf, p, uint256(y));
        p = _writeStr(buf, p, '" width="');
        p = _writeUint(buf, p, uint256(w));
        p = _writeStr(buf, p, '" height="');
        p = _writeUint(buf, p, uint256(h));
        p = _writeStr(buf, p, '" fill="rgb(');
        p = _writeUint(buf, p, uint256(r));
        p = _writeStr(buf, p, ',');
        p = _writeUint(buf, p, uint256(g));
        p = _writeStr(buf, p, ',');
        p = _writeUint(buf, p, uint256(b));
        p = _writeStr(buf, p, ')"/>');
        return p;
    }

    // ========== Buffer helpers ==========

    function _writeStr(bytes memory buf, uint256 pos, string memory s) private pure returns (uint256) {
        bytes memory str = bytes(s);
        uint256 len = str.length;
        assembly {
            let src := add(str, 32)
            let dst := add(add(buf, 32), pos)
            for { let i := 0 } lt(i, len) { i := add(i, 32) } {
                mstore(add(dst, i), mload(add(src, i)))
            }
        }
        return pos + len;
    }

    function _writeUint(bytes memory buf, uint256 pos, uint256 val) private pure returns (uint256) {
        if (val == 0) {
            buf[pos] = '0';
            return pos + 1;
        }
        uint256 temp = val;
        uint256 digits;
        while (temp != 0) {
            unchecked { ++digits; }
            temp /= 10;
        }
        uint256 endPos = pos + digits;
        temp = val;
        for (uint256 i = endPos; i > pos;) {
            unchecked { --i; }
            buf[i] = bytes1(uint8(48 + temp % 10));
            temp /= 10;
        }
        return endPos;
    }
}
