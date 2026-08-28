'use strict';

const PAIRING_PHONE_ERROR = 'Invalid phone number. Use 07XXXXXXXX or 947XXXXXXXX. Country code is required for non-local numbers, and do not include spaces or symbols.';

function normalizeSriLankanPhoneNumber(value) {
    const raw = String(value || '').trim();
    if (!raw) {
        return { ok: false, error: PAIRING_PHONE_ERROR };
    }

    const cleaned = raw.replace(/\D/g, '');
    if (!cleaned) {
        return { ok: false, error: PAIRING_PHONE_ERROR };
    }

    if (/^07\d{8}$/.test(cleaned)) {
        return { ok: true, phone: `94${cleaned.slice(1)}` };
    }

    if (/^947\d{8}$/.test(cleaned)) {
        return { ok: true, phone: cleaned };
    }

    return { ok: false, error: PAIRING_PHONE_ERROR };
}

module.exports = {
    PAIRING_PHONE_ERROR,
    normalizeSriLankanPhoneNumber,
};
