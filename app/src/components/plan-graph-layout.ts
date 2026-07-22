// Hand-rolled tidy-tree layout for a breeding plan. Plan trees are strict
// binary trees: a bred node has exactly two children (its two parents); leaves
// (Owned/Wild sources) have none. The target is the root.
//
// The layout is a left-to-right breeding *bracket*: leaves (owned pals / wild
// catches) sit in the LEFTMOST columns, each bred node one column to the right
// of its parents, and the target root in the RIGHTMOST column. Column x is a
// pure function of a node's depth from the root; row y stacks leaves in
// traversal order and places each bred node at the vertical midpoint of its two
// parents — the classic ancestry-bracket read.
//
// Output is fully positioned (node centers, one junction point per breeding
// pair, and cubic-bezier edge paths) in a single normalized, all-positive
// coordinate space shared verbatim by the SVG edge underlay and the absolutely
// positioned HTML pal nodes in plan-graph.tsx. Pure and side-effect free, so the
// geometry is unit-testable without a DOM.

import type { PlanNode } from "../lib/types";

/** Horizontal gap between breeding generations (one column per generation). */
export const COL_W = 220;
/** Vertical slot height per leaf row. */
export const ROW_H = 128;
/** Pal-node circle radius (diameter = 2·NODE_R). */
export const NODE_R = 34;
/** Label/status footprint width below each circle (used for fit bounds). */
export const NODE_W = 152;
/** Vertical space reserved below a circle for its name + status chip. */
export const LABEL_BELOW = 58;
/** Inner margin baked into the normalized coordinate space. */
const MARGIN = 10;

export interface LaidNode {
  /** Stable path id ("0", "0.0", "0.1", "0.0.1", …) — dotted child indices. */
  id: string;
  node: PlanNode;
  /** Circle center x in normalized (all-positive) content coordinates. */
  x: number;
  /** Circle center y in normalized content coordinates. */
  y: number;
  /** Generations from the root (root = 0). */
  depth: number;
}

/** The convergence point of a breeding pair, midway between the two parent
 *  edges and the bred child — where the junction chip (odds + step time) sits. */
export interface Junction {
  id: string;
  child: LaidNode;
  x: number;
  y: number;
}

export interface Edge {
  id: string;
  /** SVG cubic-bezier path in content coordinates. */
  d: string;
  /** true for the junction→child segment of a bred step (amber accent). */
  accent: boolean;
}

export interface PlanLayout {
  nodes: LaidNode[];
  junctions: Junction[];
  edges: Edge[];
  /** Content bounding-box width (includes label/circle footprint). */
  width: number;
  /** Content bounding-box height. */
  height: number;
  root: LaidNode;
}

/** A horizontal-then-vertical cubic bezier from (x1,y1) to (x2,y2). */
function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/**
 * Position an entire plan tree. Handles the degenerate single-node plan
 * (owned/catch target, zero steps) as one centered node with no edges.
 */
export function layoutPlan(root: PlanNode): PlanLayout {
  const nodes: LaidNode[] = [];
  let maxDepth = 0;
  let nextRow = 0;

  // Post-order walk: leaves claim sequential rows (left subtree first), and
  // each internal node centers between its first and last child so subtrees
  // never overlap.
  function walk(node: PlanNode, depth: number, id: string): LaidNode {
    maxDepth = Math.max(maxDepth, depth);
    let y: number;
    if (node.children.length === 0) {
      y = nextRow * ROW_H;
      nextRow += 1;
    } else {
      const kids = node.children.map((c, i) => walk(c, depth + 1, `${id}.${i}`));
      y = (kids[0].y + kids[kids.length - 1].y) / 2;
    }
    const laid: LaidNode = { id, node, x: 0, y, depth };
    nodes.push(laid);
    return laid;
  }
  const root0 = walk(root, 0, "0");

  // Column x from depth: the root (depth 0) lands in the rightmost column,
  // leaves (deepest) in the leftmost.
  for (const n of nodes) n.x = (maxDepth - n.depth) * COL_W;

  // Normalize into an all-positive space with a uniform inner margin, so the
  // SVG underlay and HTML nodes share one origin.
  const offX = NODE_W / 2 + MARGIN;
  const offY = NODE_R + MARGIN;
  for (const n of nodes) {
    n.x += offX;
    n.y += offY;
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const junctions: Junction[] = [];
  const edges: Edge[] = [];

  for (const n of nodes) {
    if (n.node.children.length === 0) continue;
    // Junction: horizontally midway between this node and its parents' column,
    // vertically at this (bred) node's center — the convergence of both edges.
    const jx = n.x - COL_W / 2;
    const jy = n.y;
    junctions.push({ id: `j-${n.id}`, child: n, x: jx, y: jy });

    // junction -> child (carries the bred accent for a breed step).
    edges.push({
      id: `e-${n.id}-c`,
      d: bezier(jx, jy, n.x - NODE_R, n.y),
      accent: n.node.source === "Bred",
    });

    // each parent -> junction.
    n.node.children.forEach((_, i) => {
      const p = byId.get(`${n.id}.${i}`);
      if (!p) return;
      edges.push({
        id: `e-${p.id}-j`,
        d: bezier(p.x + NODE_R, p.y, jx, jy),
        accent: false,
      });
    });
  }

  const width = Math.max(...nodes.map((n) => n.x)) + NODE_W / 2 + MARGIN;
  const height =
    Math.max(...nodes.map((n) => n.y)) + NODE_R + LABEL_BELOW + MARGIN;

  return { nodes, junctions, edges, width, height, root: root0 };
}
