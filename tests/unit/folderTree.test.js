import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  indexById,
  indexChildren,
  getAncestorIds,
  getDepth,
  getSubtreeHeight,
  collectDescendantIds,
  wouldCreateCycle,
  wouldExceedDepth,
  depthForNewChild,
} from "../../src/domain/folderTree.js";

describe("folderTree - pure tree logic (Task F-T1)", () => {
  // Setup standard dataset from section 7.4:
  // A (root), B (child of A), C (child of B), D (root)
  const sampleFolders = [
    { id: "A", parentId: null, name: "Folder A" },
    { id: "B", parentId: "A", name: "Folder B" },
    { id: "C", parentId: "B", name: "Folder C" },
    { id: "D", parentId: null, name: "Folder D" },
  ];

  const byId = indexById(sampleFolders);
  const children = indexChildren(sampleFolders);

  describe("indexById and indexChildren", () => {
    it("indexes folders by their ID", () => {
      assert.equal(byId.size, 4);
      assert.equal(byId.get("A").name, "Folder A");
      assert.equal(byId.get("C").parentId, "B");
    });

    it("indexes children by parentId with null as root key", () => {
      const roots = children.get(null);
      assert.equal(roots.length, 2);
      assert.deepEqual(roots.map((f) => f.id).sort(), ["A", "D"]);

      const aChildren = children.get("A");
      assert.equal(aChildren.length, 1);
      assert.equal(aChildren[0].id, "B");

      const bChildren = children.get("B");
      assert.equal(bChildren.length, 1);
      assert.equal(bChildren[0].id, "C");

      assert.equal(children.has("C"), false);
    });
  });

  describe("getDepth", () => {
    it("returns expected depths from test vector: A=1, B=2, C=3, D=1", () => {
      assert.equal(getDepth(byId, "A"), 1);
      assert.equal(getDepth(byId, "B"), 2);
      assert.equal(getDepth(byId, "C"), 3);
      assert.equal(getDepth(byId, "D"), 1);
    });

    it("returns 0 for non-existent folder id", () => {
      assert.equal(getDepth(byId, "UNKNOWN"), 0);
    });
  });

  describe("getSubtreeHeight", () => {
    it("returns expected subtree heights from test vector: A=3, B=2, C=1, D=1", () => {
      assert.equal(getSubtreeHeight(children, "A"), 3);
      assert.equal(getSubtreeHeight(children, "B"), 2);
      assert.equal(getSubtreeHeight(children, "C"), 1);
      assert.equal(getSubtreeHeight(children, "D"), 1);
    });

    it("returns 1 for a leaf or non-existent parent in children map", () => {
      assert.equal(getSubtreeHeight(children, "UNKNOWN"), 1);
    });
  });

  describe("getAncestorIds", () => {
    it("returns [B, A] for folder C", () => {
      assert.deepEqual(getAncestorIds(byId, "C"), ["B", "A"]);
    });

    it("returns [A] for folder B", () => {
      assert.deepEqual(getAncestorIds(byId, "B"), ["A"]);
    });

    it("returns [] for root folders A and D", () => {
      assert.deepEqual(getAncestorIds(byId, "A"), []);
      assert.deepEqual(getAncestorIds(byId, "D"), []);
    });

    it("throws an error when a cycle is detected in stored data", () => {
      // Data with loop: X parent is Y, Y parent is X
      const cyclicFolders = [
        { id: "X", parentId: "Y" },
        { id: "Y", parentId: "X" },
      ];
      const cyclicById = indexById(cyclicFolders);
      assert.throws(
        () => getAncestorIds(cyclicById, "X"),
        /cycle detected in stored data/i
      );
    });
  });

  describe("collectDescendantIds", () => {
    it("returns {A, B, C} for folder A", () => {
      const descendants = collectDescendantIds(children, "A");
      assert.deepEqual(Array.from(descendants).sort(), ["A", "B", "C"]);
    });

    it("returns {D} for folder D (leaf root)", () => {
      const descendants = collectDescendantIds(children, "D");
      assert.deepEqual(Array.from(descendants), ["D"]);
    });

    it("returns {C} for folder C (leaf)", () => {
      const descendants = collectDescendantIds(children, "C");
      assert.deepEqual(Array.from(descendants), ["C"]);
    });
  });

  describe("wouldCreateCycle", () => {
    it("wouldCreateCycle(moving=A, newParent=C) -> true", () => {
      assert.equal(wouldCreateCycle(byId, "A", "C"), true);
    });

    it("wouldCreateCycle(moving=A, newParent=B) -> true", () => {
      assert.equal(wouldCreateCycle(byId, "A", "B"), true);
    });

    it("wouldCreateCycle(moving=A, newParent=A) -> true (cannot parent to itself)", () => {
      assert.equal(wouldCreateCycle(byId, "A", "A"), true);
    });

    it("wouldCreateCycle(moving=A, newParent=D) -> false", () => {
      assert.equal(wouldCreateCycle(byId, "A", "D"), false);
    });

    it("wouldCreateCycle(moving=C, newParent=A) -> false (moving C under A is valid)", () => {
      assert.equal(wouldCreateCycle(byId, "C", "A"), false);
    });

    it("wouldCreateCycle(moving=B, newParent=null) -> false (moving to root is valid)", () => {
      assert.equal(wouldCreateCycle(byId, "B", null), false);
    });
  });

  describe("wouldExceedDepth", () => {
    it("wouldExceedDepth(moving=D, newParent=C, max=3) -> true (3 + 1 > 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "D", "C", 3), true);
    });

    it("wouldExceedDepth(moving=D, newParent=B, max=3) -> false (2 + 1 = 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "D", "B", 3), false);
    });

    it("wouldExceedDepth(moving=A, newParent=D, max=3) -> true (1 + 3 > 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "A", "D", 3), true);
    });

    it("wouldExceedDepth(moving=A, newParent=null, max=3) -> false (0 + 3 = 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "A", null, 3), false);
    });
  });

  describe("depthForNewChild", () => {
    it("returns 1 when parentId is null (new root folder)", () => {
      assert.equal(depthForNewChild(byId, null), 1);
    });

    it("returns parentDepth + 1 for existing parent", () => {
      assert.equal(depthForNewChild(byId, "A"), 2);
      assert.equal(depthForNewChild(byId, "B"), 3);
      assert.equal(depthForNewChild(byId, "C"), 4);
    });
  });
});
