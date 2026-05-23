// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Renderer} from "../Renderer.sol";

/// @notice Byte-for-byte parity tests against the canonical JS reference
/// renderer (renderer/recursivesubdivision.js). The hashes are keccak256 of
/// the JS output for the same (xs, ys, prompt) inputs. Any divergence in the
/// Solidity port — PRNG advance order, splice ordering, integer rounding —
/// changes the hash and fails the test.
///
/// History: an off-by-one in _splice2/_splice3 caused the tail region of the
/// array to be silently dropped on every salt op, leaving large white holes
/// in the on-chain SVG (visible on Mixed Messages #1's OpenSea page). These
/// fixtures pin the corrected output so the same class of bug cannot regress.
contract RendererParityTest is Test {
    Renderer internal renderer;

    function setUp() public {
        renderer = new Renderer();
    }

    /// Small fixture: 1 submission. Exercises the splice paths at low region
    /// counts (where the off-by-one was catastrophic).
    function test_parity_singleCoord_THE_INTERNET() public view {
        uint16[] memory xs = new uint16[](1);
        uint16[] memory ys = new uint16[](1);
        xs[0] = 771;
        ys[0] = 1241;

        string memory svg = renderer.renderSVG(xs, ys, "THE INTERNET");
        bytes32 expected = 0x0f2650fad8de96a7db5b507a89884be9807eeaa928b2e6dc5131c57e4044ef98;
        assertEq(keccak256(bytes(svg)), expected, "single-coord SVG diverges from JS reference");

        // Belt and suspenders: assert no zero-area rects (the bug's smoking gun).
        _assertNoZeroRects(svg);
    }

    /// Full fixture: Mixed Messages #1's 92 submissions. Exercises hundreds
    /// of salt ops and many splice positions.
    function test_parity_day1_THE_INTERNET() public view {
        (uint16[] memory xs, uint16[] memory ys) = _day1Coords();

        string memory svg = renderer.renderSVG(xs, ys, "THE INTERNET");
        bytes32 expected = 0x7bb71f2f68a340955d9d16331500bc7ebd447e80cddc1ffaa7fdec0601b95c56;
        assertEq(keccak256(bytes(svg)), expected, "day-1 SVG diverges from JS reference");

        _assertNoZeroRects(svg);
    }

    /// Scans the SVG for any rect with width="0" or height="0" — the splice
    /// bug's fingerprint was zero-initialized memory leaking through as
    /// {x=0,y=0,w=0,h=0,fill=rgb(0,0,0)} rects.
    function _assertNoZeroRects(string memory svg) internal pure {
        bytes memory b = bytes(svg);
        bytes memory needleW = bytes('width="0"');
        bytes memory needleH = bytes('height="0"');
        for (uint256 i = 0; i + needleW.length <= b.length; i++) {
            bool matchW = true;
            for (uint256 j; j < needleW.length; j++) {
                if (b[i + j] != needleW[j]) { matchW = false; break; }
            }
            require(!matchW, "renderer emitted zero-width rect");
            if (i + needleH.length > b.length) continue;
            bool matchH = true;
            for (uint256 j; j < needleH.length; j++) {
                if (b[i + j] != needleH[j]) { matchH = false; break; }
            }
            require(!matchH, "renderer emitted zero-height rect");
        }
    }

    /// Mixed Messages #1's stored coordinates, in storage order. Pulled from
    /// the deployed MixedMessages contract on Ethereum mainnet
    /// (0x0169a0dd0a5cfe48e80539eb02a4e221b8f77991) at deploy time.
    function _day1Coords() internal pure returns (uint16[] memory xs, uint16[] memory ys) {
        uint16[92] memory xsRaw = [
            uint16(2151), uint16(3946), uint16(2244), uint16(1955), uint16(2514), uint16(5044), uint16(1051), uint16(4187), uint16(441), uint16(1792), uint16(459), uint16(2906),
            uint16(3909), uint16(1755), uint16(771), uint16(1921), uint16(4128), uint16(1673), uint16(4941), uint16(4358), uint16(2136), uint16(1571), uint16(4714), uint16(1760),
            uint16(163), uint16(4760), uint16(1430), uint16(461), uint16(672), uint16(3923), uint16(3750), uint16(4605), uint16(4843), uint16(1596), uint16(3437), uint16(1225),
            uint16(1684), uint16(4449), uint16(4372), uint16(3002), uint16(1837), uint16(84), uint16(4801), uint16(4052), uint16(3163), uint16(434), uint16(59), uint16(317),
            uint16(4784), uint16(7663), uint16(9786), uint16(5938), uint16(9456), uint16(6082), uint16(8949), uint16(800), uint16(1500), uint16(400), uint16(1800), uint16(1200),
            uint16(600), uint16(2000), uint16(1782), uint16(7688), uint16(4784), uint16(1757), uint16(1973), uint16(1482), uint16(4995), uint16(4992), uint16(2658), uint16(5800),
            uint16(2480), uint16(2520), uint16(2495), uint16(2515), uint16(2470), uint16(2530), uint16(2500), uint16(2200), uint16(2850), uint16(2400), uint16(2700), uint16(2100),
            uint16(2950), uint16(2550), uint16(824), uint16(2327), uint16(7083), uint16(2123), uint16(5010), uint16(3684)
        ];
        uint16[92] memory ysRaw = [
            uint16(5333), uint16(4514), uint16(2161), uint16(8231), uint16(6899), uint16(9679), uint16(1067), uint16(4907), uint16(3190), uint16(2523), uint16(3345), uint16(229),
            uint16(373), uint16(641), uint16(1241), uint16(974), uint16(1292), uint16(1981), uint16(3024), uint16(743), uint16(4361), uint16(3980), uint16(4221), uint16(2478),
            uint16(1999), uint16(484), uint16(1008), uint16(7996), uint16(7505), uint16(8930), uint16(7145), uint16(6421), uint16(7310), uint16(8653), uint16(8971), uint16(9000),
            uint16(9709), uint16(8359), uint16(7139), uint16(7122), uint16(9964), uint16(9758), uint16(5914), uint16(7290), uint16(5161), uint16(6910), uint16(5058), uint16(9579),
            uint16(9255), uint16(4429), uint16(932), uint16(3381), uint16(5716), uint16(6416), uint16(6419), uint16(9200), uint16(8700), uint16(9500), uint16(9100), uint16(8400),
            uint16(8900), uint16(9300), uint16(7091), uint16(2462), uint16(4892), uint16(7568), uint16(4162), uint16(8266), uint16(5009), uint16(8134), uint16(2364), uint16(3672),
            uint16(7510), uint16(7490), uint16(7535), uint16(7465), uint16(7480), uint16(7520), uint16(7500), uint16(7300), uint16(7650), uint16(7900), uint16(7150), uint16(7600),
            uint16(7400), uint16(7800), uint16(1685), uint16(2249), uint16(7328), uint16(4246), uint16(4990), uint16(4211)
        ];
        xs = new uint16[](92);
        ys = new uint16[](92);
        for (uint256 i; i < 92; i++) {
            xs[i] = xsRaw[i];
            ys[i] = ysRaw[i];
        }
    }
}
