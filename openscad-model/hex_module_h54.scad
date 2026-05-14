// Hex module enclosure with 6-side pogopin boards -- 3x height variant
// All units in mm

/* ---------- parameters ---------- */

// Hex body
edge_outer   = 40.0;   // outer edge length of hex
body_h       = 54.0;   // body height (excluding cap) -- 3x base version
// Wall
wall_t         = 4.0;    // wall thickness = outer_slot_depth + pocket_depth

// Pogopin module (stepped obround profile) on each of 6 faces
// --- outer step: embedded into the wall, pogopin-exposing slot ---
outer_slot_len   = 24.8;   // total length incl. both φ end-circles
outer_slot_dia   = 4.8;    // height / end-circle diameter
outer_slot_depth = 2.0;    // embedded depth (from outer face)

// --- inner step: flange sitting inside the wall, includes mounting ears ---
inner_pocket_len   = 30.6;
inner_pocket_dia   = 4.8;
inner_pocket_depth = 2.0;  // recess depth from inner wall face

pocket_clear   = 0.2;      // clearance added per side vs nominal module size

board_z_c      = 9.0;      // slot vertical center (Z) -- consistent across modules

// Base plate & cap
base_t       = 2.0;    // floor thickness (internal floor of hex body)
cap_plug_h   = 3.0;    // how deep the cap plug sits into body
cap_top_h    = 2.0;    // cap lid thickness above the plug
cap_clear    = 0.3;    // clearance on each side between plug and body

// Rendering
$fn = 96;

/* ---------- derived ---------- */
// hex inscribed (apothem) = edge * sqrt(3)/2
apothem_outer = edge_outer * sqrt(3) / 2;
edge_inner    = edge_outer - 2 * wall_t / (sqrt(3)/2);
                // shrinking apothem by wall_t -> edge shrinks by wall_t*2/sqrt(3)... but we use
                // a simpler approach: subtract a smaller hex prism scaled by apothem
apothem_inner = apothem_outer - wall_t;

/* ---------- helpers ---------- */

// regular hexagon centered at origin, flat side facing +Y
module hex_prism(edge, h) {
    // built from 6 rotated rectangles -> use cylinder $fn=6 for simplicity
    // cylinder r=edge, $fn=6 gives hex with edge length = r
    cylinder(h = h, r = edge, $fn = 6, center = false);
}

// inner hex cavity by apothem (distance from center to flat face)
module hex_prism_by_apothem(apothem, h) {
    // edge length e where apothem = e*sqrt(3)/2  =>  e = apothem*2/sqrt(3)
    e = apothem * 2 / sqrt(3);
    hex_prism(e, h);
}

/* ---------- feature: obround pogopin slot on one face (face along +Y) ---------- */
// 2D obround: hull of two circles, length=slot_len, diameter=slot_dia
module obround_2d(length, dia) {
    r = dia / 2;
    hull() {
        translate([-(length/2 - r), 0]) circle(r = r);
        translate([ (length/2 - r), 0]) circle(r = r);
    }
}

// Cut the stepped slot on one face (face at y = +apothem_outer, normal = +Y).
// Outer step (24.8): punches from outer face inward by outer_slot_depth.
// Inner step (30.6): recess from inner face outward by inner_pocket_depth.
module face_slot_cut() {
    // outer step -- from outer face (y = apothem_outer) going inward
    translate([0, apothem_outer + 0.01, board_z_c])
        rotate([90, 0, 0])
            linear_extrude(height = outer_slot_depth + 0.02)
                obround_2d(outer_slot_len + 2*pocket_clear,
                           outer_slot_dia + 2*pocket_clear);

    // inner step (flange pocket) -- from inner face (y = apothem_outer - wall_t) going outward
    translate([0, apothem_outer - wall_t + inner_pocket_depth + 0.01, board_z_c])
        rotate([90, 0, 0])
            linear_extrude(height = inner_pocket_depth + 0.02)
                obround_2d(inner_pocket_len + 2*pocket_clear,
                           inner_pocket_dia + 2*pocket_clear);
}

/* ---------- main body ---------- */

module hex_body() {
    difference() {
        // outer solid
        hex_prism(edge_outer, body_h);

        // inner cavity (leave base_t floor)
        translate([0, 0, base_t])
            hex_prism_by_apothem(apothem_inner, body_h - base_t + 1);

        // cut obround slot on all 6 faces
        for (i = [0:5])
            rotate([0, 0, 60 * i])
                face_slot_cut();
    }
}

/* ---------- cap (plug style) ---------- */

module cap() {
    // top lid sitting above body, with a plug going down into the body opening
    translate([0, 0, 0]) {
        // lid (slightly larger than body to act as a lip) -- keep flush if you prefer
        hex_prism(edge_outer, cap_top_h);
        // plug that fits into the inner hex cavity
        translate([0, 0, -cap_plug_h])
            hex_prism_by_apothem(apothem_inner - cap_clear, cap_plug_h + 0.01);
    }
}

/* ---------- layout ---------- */

// body
hex_body();

// cap (shifted to the side for printing preview; move on top to check fit)
translate([edge_outer * 2.2, 0, cap_top_h])
    rotate([180, 0, 0])
        cap();

// --- uncomment to preview cap assembled on body ---
// translate([0, 0, body_h + cap_top_h]) rotate([180,0,0]) cap();
