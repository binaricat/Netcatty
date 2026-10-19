/* Test-only OpenSSH SK provider. Software keys here NEVER protect real accounts.
 * Implements the OpenSSH sk-api.h contract using OpenSSL, without USB hardware.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <openssl/evp.h>
#include <openssl/ec.h>
#include <openssl/ecdsa.h>
#include <openssl/sha.h>
#include <openssl/x509.h>
#include "sk-api.h"

uint32_t sk_api_version(void) { return SSH_SK_VERSION_MAJOR; }

static int check_pin(uint8_t flags, const char *pin) {
    if ((flags & SSH_SK_USER_VERIFICATION_REQD)
        && (pin == NULL || strcmp(pin, "123456") != 0))
        return SSH_SK_ERR_PIN_REQUIRED;
    return 0;
}

static int check_device(void) {
    const char *control = getenv("NETCATTY_FIDO_SIM_CONTROL");
    if (!control) return 0;
    char action[32] = {0};
    FILE *input = fopen(control, "r");
    if (input) { (void)fgets(action, sizeof(action), input); fclose(input); }
    if (!strncmp(action, "unplugged", 9)) return SSH_SK_ERR_DEVICE_NOT_FOUND;
    if (!strncmp(action, "unsupported", 11)) return SSH_SK_ERR_UNSUPPORTED;
    return 0;
}

/* Optional, test-only physical-presence gate. The host test changes this file
 * to emulate a touch/unplug; a renderer response cannot bypass this gate. */
static int await_touch(uint8_t *flags) {
    const char *control = getenv("NETCATTY_FIDO_SIM_CONTROL");
    if (!control) return 0;
    char marker[4096];
    snprintf(marker, sizeof(marker), "%s.waiting", control);
    FILE *ready = fopen(marker, "w");
    if (ready) fclose(ready);
    for (int i = 0; i < 150; i++) {
        char action[32] = {0};
        FILE *input = fopen(control, "r");
        if (input) { (void)fgets(action, sizeof(action), input); fclose(input); }
        if (!strncmp(action, "unplugged", 9)) return SSH_SK_ERR_DEVICE_NOT_FOUND;
        if (!strncmp(action, "no-up", 5)) { *flags &= ~SSH_SK_USER_PRESENCE_REQD; return 0; }
        if (!strncmp(action, "no-uv", 5)) { *flags &= ~SSH_SK_USER_VERIFICATION_REQD; return 0; }
        if (!strncmp(action, "touch", 5)) return 0;
        usleep(20000);
    }
    return SSH_SK_ERR_GENERAL;
}

int sk_enroll(uint32_t alg, const uint8_t *challenge, size_t challenge_len,
    const char *application, uint8_t flags, const char *pin,
    struct sk_option **options, struct sk_enroll_response **result) {
    (void)challenge; (void)challenge_len; (void)application; (void)options;
    int status = check_pin(flags, pin);
    if (status) return status;
    EVP_PKEY *key = NULL;
    if (alg == SSH_SK_ED25519) key = EVP_PKEY_Q_keygen(NULL, NULL, "ED25519");
    else if (alg == SSH_SK_ECDSA) key = EVP_PKEY_Q_keygen(NULL, NULL, "EC", "P-256");
    if (!key) return SSH_SK_ERR_UNSUPPORTED;
    struct sk_enroll_response *response = calloc(1, sizeof(*response));
    response->flags = flags;
    if (alg == SSH_SK_ED25519) {
        response->public_key_len = 32;
        response->public_key = malloc(32);
        EVP_PKEY_get_raw_public_key(key, response->public_key, &response->public_key_len);
    } else {
        EVP_PKEY_get_octet_string_param(key, "pub", NULL, 0, &response->public_key_len);
        response->public_key = malloc(response->public_key_len);
        EVP_PKEY_get_octet_string_param(key, "pub", response->public_key,
            response->public_key_len, &response->public_key_len);
    }
    /* Embed the disposable software private key as the opaque test handle. */
    response->key_handle_len = i2d_PrivateKey(key, &response->key_handle);
    response->signature = calloc(1, 1);
    EVP_PKEY_free(key);
    *result = response;
    return 0;
}

int sk_sign(uint32_t alg, const uint8_t *data, size_t data_len,
    const char *application, const uint8_t *handle, size_t handle_len,
    uint8_t flags, const char *pin, struct sk_option **options,
    struct sk_sign_response **result) {
    (void)options;
    int status = check_device();
    if (status) return status;
    status = check_pin(flags, pin);
    if (status) return status;
    status = await_touch(&flags);
    if (status) return status;
    EVP_PKEY *key = d2i_AutoPrivateKey(NULL, &handle, handle_len);
    if (!key) return SSH_SK_ERR_GENERAL;
    /* OpenSSH signs SHA256(application) || flags || counter || SHA256(data). */
    uint8_t message[69] = {0};
    SHA256((const uint8_t *)application, strlen(application), message);
    message[32] = flags;
    message[36] = 1;
    SHA256(data, data_len, message + 37);
    EVP_MD_CTX *ctx = EVP_MD_CTX_new();
    uint8_t signature[128];
    size_t signature_len = sizeof(signature);
    int ok = EVP_DigestSignInit(ctx, NULL,
        alg == SSH_SK_ECDSA ? EVP_sha256() : NULL, NULL, key)
        && EVP_DigestSign(ctx, signature, &signature_len, message, sizeof(message));
    EVP_MD_CTX_free(ctx);
    EVP_PKEY_free(key);
    if (!ok) return SSH_SK_ERR_GENERAL;
    struct sk_sign_response *response = calloc(1, sizeof(*response));
    response->flags = flags;
    response->counter = 1;
    if (alg == SSH_SK_ECDSA) {
        const uint8_t *ptr = signature;
        ECDSA_SIG *sig = d2i_ECDSA_SIG(NULL, &ptr, signature_len);
        if (!sig) { free(response); return SSH_SK_ERR_GENERAL; }
        const BIGNUM *r, *s;
        ECDSA_SIG_get0(sig, &r, &s);
        response->sig_r_len = BN_num_bytes(r);
        response->sig_s_len = BN_num_bytes(s);
        response->sig_r = malloc(response->sig_r_len);
        response->sig_s = malloc(response->sig_s_len);
        BN_bn2bin(r, response->sig_r);
        BN_bn2bin(s, response->sig_s);
        ECDSA_SIG_free(sig);
    } else {
        response->sig_r = malloc(signature_len);
        memcpy(response->sig_r, signature, signature_len);
        response->sig_r_len = signature_len;
    }
    *result = response;
    return 0;
}

int sk_load_resident_keys(const char *pin, struct sk_option **options,
    struct sk_resident_key ***keys, size_t *count) {
    (void)pin; (void)options; (void)keys; (void)count;
    return SSH_SK_ERR_UNSUPPORTED;
}
