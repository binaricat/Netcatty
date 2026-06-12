const test = require("node:test");
const assert = require("node:assert/strict");

const {
  filterExcludedFigSpecs,
  isExcludedFigSpec,
} = require("../main/registerBridges.cjs");

test("filters cloud fig specs removed from packaged builds", () => {
  assert.equal(isExcludedFigSpec("aws"), true);
  assert.equal(isExcludedFigSpec("aws/s3"), true);
  assert.equal(isExcludedFigSpec("gcloud"), true);
  assert.equal(isExcludedFigSpec("gcloud/compute"), true);
  assert.equal(isExcludedFigSpec("az"), true);
  assert.equal(isExcludedFigSpec("az/2.53.0"), true);
  assert.equal(isExcludedFigSpec("aws-vault"), false);

  assert.deepEqual(
    filterExcludedFigSpecs(["git", "aws", "aws/s3", "gcloud", "az/2.53.0", "aws-vault"]),
    ["git", "aws-vault"],
  );
});
