/**
 * Tests for SSH key-type detection of imported keys.
 * Fixtures are real ssh-keygen/openssl outputs committed inline so the tests
 * run offline; each is a throwaway key with no passphrase.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { detectSshKeyType } from "./keyTypeDetect";

const ecdsaP256 = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAaAAAABNlY2RzYS\n1zaGEyLW5pc3RwMjU2AAAACG5pc3RwMjU2AAAAQQQvnbE+AaCddvtJFMjaax10oenmFmQM\npXAcjy2UGyDgtfu3lEaPtaIH46w6N20f9yYAON2MvWW0/eRuCpdJHTkMAAAAsHVdVZ91XV\nWfAAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBC+dsT4BoJ12+0kU\nyNprHXSh6eYWZAylcByPLZQbIOC1+7eURo+1ogfjrDo3bR/3JgA43Yy9ZbT95G4Kl0kdOQ\nwAAAAgStX6Lob7zcAycW7KaJSCXLJrilDhJXG1WFQgGl9y62IAAAAUcnVubmVyQHJ1bm5l\ncnZtbHVuNXABAgME\n-----END OPENSSH PRIVATE KEY-----\n";

const ecdsaP384 = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAiAAAABNlY2RzYS\n1zaGEyLW5pc3RwMzg0AAAACG5pc3RwMzg0AAAAYQSQS6EWgw29J9MLGrZLfMn76MmM5ALy\nQ4+04xJGATjEf6MEOIAK0wSBFZl8to7emVfBc1zzAj3ha+GBhJhb0um5SSm9FPyWwAiIJf\nBVzRLlmGzQovAI01eQmL1/4ucmSvUAAADgtNoSebTaEnkAAAATZWNkc2Etc2hhMi1uaXN0\ncDM4NAAAAAhuaXN0cDM4NAAAAGEEkEuhFoMNvSfTCxq2S3zJ++jJjOQC8kOPtOMSRgE4xH\n+jBDiACtMEgRWZfLaO3plXwXNc8wI94WvhgYSYW9LpuUkpvRT8lsAIiCXwVc0S5Zhs0KLw\nCNNXkJi9f+LnJkr1AAAAMQCYPLvcPHCq3bUIuaeu3p0bKq1/C2OHA1lC0hpq+1fDf6FTGR\nvFItzEY9ZtFvC3AWMAAAAUcnVubmVyQHJ1bm5lcnZtbHVuNXABAgM=\n-----END OPENSSH PRIVATE KEY-----\n";

const ecdsaP521 = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAArAAAABNlY2RzYS\n1zaGEyLW5pc3RwNTIxAAAACG5pc3RwNTIxAAAAhQQBavWy9eXpHL30+xFqt3nDv+ePLDCD\nOg4N1cuMNIHckv5rgoDGvvDQMjtGczs3kC0xabLtv601MRUvBhFPwE4Y034A7vHCE6RAWp\nq00peOjvI+1LGT/O6VcK/jRek0Ff2SFyuRQnEr831OzbaSDmW2jGdy9nbqinb5YQJJxtap\nMZX1OywAAAEY25lDYduZQ2EAAAATZWNkc2Etc2hhMi1uaXN0cDUyMQAAAAhuaXN0cDUyMQ\nAAAIUEAWr1svXl6Ry99PsRard5w7/njywwgzoODdXLjDSB3JL+a4KAxr7w0DI7RnM7N5At\nMWmy7b+tNTEVLwYRT8BOGNN+AO7xwhOkQFqatNKXjo7yPtSxk/zulXCv40XpNBX9khcrkU\nJxK/N9Ts22kg5ltoxncvZ26op2+WECScbWqTGV9TssAAAAQgEPqPBDx3/8K4g0fzQn57FF\naCq4Cs2JZz9BHWx63zwlRQq8IhQKbZecPynvKNWLy8LOp8XfNVZTwQBKMz9QekGeuAAAAB\nRydW5uZXJAcnVubmVydm1sdW41cAECAwQFBg==\n-----END OPENSSH PRIVATE KEY-----\n";

const ecdsaPkcs8 = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgugGgbsmFOKG8JT1q\n6Ay3bj1PDVhdp1XtdEHVE6NJzaahRANCAAToTR6xUeCdtmkog/Bo92A9ulj68geF\nKGBHlkOAK276jQJreRIbgzDvnuXJYIcdFT8Hld+NKcYpW3G9Ldk1dIaN\n-----END PRIVATE KEY-----\n";

const ed25519 = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACByAuOzP1a94fFc6lzn1dkzlZulhkgFw7iwLTQZDxkBXgAAAJhgsFpyYLBa\ncgAAAAtzc2gtZWQyNTUxOQAAACByAuOzP1a94fFc6lzn1dkzlZulhkgFw7iwLTQZDxkBXg\nAAAEB+G4mdoS5EtP1EOdUWi2dtZOSbzlKgwHiIMGnu0F4kJnIC47M/Vr3h8VzqXOfV2TOV\nm6WGSAXDuLAtNBkPGQFeAAAAFHJ1bm5lckBydW5uZXJ2bWx1bjVwAQ==\n-----END OPENSSH PRIVATE KEY-----\n";

const ed25519Pkcs8 = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACDRXAZBDSSce/bfa6hj2HEd62xJWSwTu9SEMTH94ytWaQAAAJg4DMdFOAzH\nRQAAAAtzc2gtZWQyNTUxOQAAACDRXAZBDSSce/bfa6hj2HEd62xJWSwTu9SEMTH94ytWaQ\nAAAEDCmdEVlGRm4wzFTThmFJUlHe2P38nLyTIK75rLl5uqC9FcBkENJJx79t9rqGPYcR3r\nbElZLBO71IQxMf3jK1ZpAAAAFHJ1bm5lckBydW5uZXJ2bWx1bjVwAQ==\n-----END OPENSSH PRIVATE KEY-----\n";

const rsa = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn\nNhAAAAAwEAAQAAAQEAksdZMjBmIgapaqsWuzUUxP3aiHf1YrPRrHlQVlojhSvhq9gKjUlW\n5kM2cy70jtPmw3hQHdY/aYXWDJ8VxOMiJ5HnacL0WzgRFxBh1UgbRUFPfu6z8I0xUvQxBT\nZdoIYqFL4UbfI8K4TrgqBDt1RQ7qipOsldeyM0sjVgspIpHa7m0nrlpKVcyGZOuQPaJxN6\npYlwEO/D9/0Y1Xy+x/RdWpFBDTR+4cJyBdF+u6QziLz4ckJPHVJ2i69WoWDFWk3YxKlfl0\nRXlSas/O07rrTvz8cflvVkcqt/tI3TuCic3eBpW5Y2z+49EKo764SiWmrQM4++75v0GC4T\nc0BJHKIUxQAAA9AbHmyUGx5slAAAAAdzc2gtcnNhAAABAQCSx1kyMGYiBqlqqxa7NRTE/d\nqId/Vis9GseVBWWiOFK+Gr2AqNSVbmQzZzLvSO0+bDeFAd1j9phdYMnxXE4yInkedpwvRb\nOBEXEGHVSBtFQU9+7rPwjTFS9DEFNl2ghioUvhRt8jwrhOuCoEO3VFDuqKk6yV17IzSyNW\nCykikdrubSeuWkpVzIZk65A9onE3qliXAQ78P3/RjVfL7H9F1akUENNH7hwnIF0X67pDOI\nvPhyQk8dUnaLr1ahYMVaTdjEqV+XRFeVJqz87TuutO/Pxx+W9WRyq3+0jdO4KJzd4Glblj\nbP7j0QqjvrhKJaatAzj77vm/QYLhNzQEkcohTFAAAAAwEAAQAAAQAJmgcrNyr55IQA/tfZ\n/5hwDzJ/BT3lADdh+Cj5unl4Cjf/36jyYiRQTtWehlP9jejFdmGN+h3O1Nr88LaMroEQTp\nqb+rgKdD9Qn26O9GHC+jPtl/GRyw1kIaZH8teqxcFgoaiWIqet/yAlkj9WcappBQPWXSWD\nhc46LtoNrxhdISJUw4hoLk6kF+gCvTxg+HFdnMzgP3uaTt30Nu50l6ObibNVA+HgfsW3X7\nNpNGQFICoz2dpXeR+W5IFc0RsetbafViOkINrh0VR4XwqT+O85SFw5uUeKdiI04zsdBuLc\n64RSi/pdhjeoigreLgnrNJdDBItr0MyGC4vxGCSzxgwXAAAAgQDM+iNHVDx7eeeArZ9QgZ\noDDIXO23QgVn0wy4fVqCA58c7jfDf38Zi+r1OAxmpOBC3uuxeFG9JCgPIaxrTMCpR/lm6A\nXTtwt7xnJng0kEb0HFo1OutA3kOnH7yFu4LePrLXGLHzLTSAItQvvkYXlC1qBzhsI+hOuo\nNy+tJZlAj8wwAAAIEAzbTSlahw6AU71OejF/Swx0Vzt1eJ+zVaWRbbXzwp8ikINWcOxx7P\nftVHoc6ym1p21ODzIy0MPJaouoFuuDkDNjppgdIRx4/7IdwsgV8WQGBmGnIkbl/LVAPiUa\n5UjwTzvihWuZWc0gV1SQ69ps/sTm//Nsz1wviy7UOe3M+eDm8AAACBALaqPXxHj1wqoEDz\nzshqIOB0lh2JdNdA0j69VV5CxBE3FxSz28yokRt8ujk6Tc7TxIq7Io3wKrwXRowfUgYifF\n21L/5v8oUIWiHhrNs2TP762AceiT/5Zcng+Lyho5LZlqhPbLJ942+EUqbLaAXd4gfaaAzJ\nULE8nem1SxH1uuoLAAAAFHJ1bm5lckBydW5uZXJ2bWx1bjVwAQIDBAUG\n-----END OPENSSH PRIVATE KEY-----\n";

const ed25519Pkcs8Oid = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIKVlSCmmBY6Wn8YWY26XAN5zkD/vJYwCSIwsKk8brU27\n-----END PRIVATE KEY-----\n";

const sec1Ecdsa = "-----BEGIN EC PARAMETERS-----\nBggqhkjOPQMBBw==\n-----END EC PARAMETERS-----\n-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIDdLFJiwPdl1iJSWyGZsKguGOMJ6RCHzktI1govWhNULoAoGCCqGSM49\nAwEHoUQDQgAE5r3AAArr/FMR+klnWbM1tZXjY5/bKZmHSUgHoAbOe513vc1qemKJ\nkHaaNfqXD5NoUNw6fuHoFkWfi7YqXSD8oA==\n-----END EC PRIVATE KEY-----\n";

test("OpenSSH ECDSA P-256 keys detect as ECDSA with keySize 256", () => {
  assert.deepEqual(detectSshKeyType(ecdsaP256), { type: "ECDSA", keySize: 256 });
});

test("OpenSSH ECDSA P-384 / P-521 keys detect with matching key sizes", () => {
  assert.deepEqual(detectSshKeyType(ecdsaP384), { type: "ECDSA", keySize: 384 });
  assert.deepEqual(detectSshKeyType(ecdsaP521), { type: "ECDSA", keySize: 521 });
});

test("PKCS#8 ECDSA keys detect via DER OID, not plaintext hints", () => {
  assert.deepEqual(detectSshKeyType(ecdsaPkcs8), { type: "ECDSA", keySize: 256 });
});

test("SEC1 EC private keys detect as ECDSA", () => {
  assert.deepEqual(detectSshKeyType(sec1Ecdsa), { type: "ECDSA" });
});

test("OpenSSH and PKCS#8 Ed25519 keys stay ED25519", () => {
  assert.deepEqual(detectSshKeyType(ed25519), { type: "ED25519" });
  assert.deepEqual(detectSshKeyType(ed25519Pkcs8), { type: "ED25519" });
  assert.deepEqual(detectSshKeyType(ed25519Pkcs8Oid), { type: "ED25519" });
});

test("OpenSSH RSA keys stay RSA", () => {
  assert.deepEqual(detectSshKeyType(rsa), { type: "RSA" });
});

test("public key algorithm prefix is used as a fallback", () => {
  assert.deepEqual(
    detectSshKeyType("not a key", "ecdsa-sha2-nistp256 AAAAB2 user@host"),
    { type: "ECDSA", keySize: 256 },
  );
  assert.deepEqual(detectSshKeyType(undefined, "ssh-ed25519 AAAAC3 user@host"), {
    type: "ED25519",
  });
  assert.deepEqual(detectSshKeyType(undefined, "ssh-rsa AAAAB3 user@host"), {
    type: "RSA",
  });
});

test("unrecognizable content defaults to ED25519 (ssh-keygen default)", () => {
  assert.deepEqual(detectSshKeyType("random text"), { type: "ED25519" });
  assert.deepEqual(detectSshKeyType(undefined, undefined), { type: "ED25519" });
});
