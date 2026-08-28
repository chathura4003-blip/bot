'use strict';

const { DEFAULT_ADMIN_PASS, DEFAULT_JWT_SECRET } = require('../config');
const packageJson = require('../package.json');

function hasValue(value) {
    return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function parseNodeMajor(version) {
    const match = String(version || '').match(/^v?(\d+)/);
    return match ? Number.parseInt(match[1], 10) : null;
}

function parseMinNodeMajor(range, fallback) {
    const match = String(range || '').match(/(\d+)/);
    return match ? Number.parseInt(match[1], 10) : fallback;
}

function validateConfig(cfg) {
    const warnings = [];
    const explicitMode = String(process.env.NODE_ENV || 'development').trim().toLowerCase() || 'development';
    const supportedNodeRange = packageJson.engines?.node || '>=20';
    const minSupportedMajor = parseMinNodeMajor(supportedNodeRange, 20);
    const nodeMajor = parseNodeMajor(process.version);
    const unsupportedNode = nodeMajor === null || nodeMajor < minSupportedMajor;
    const adminPassMissing = !hasValue(cfg.ADMIN_PASS);
    const jwtSecretMissing = !hasValue(cfg.JWT_SECRET);
    const adminPassDefault = cfg.ADMIN_PASS === DEFAULT_ADMIN_PASS;
    const jwtSecretDefault = cfg.JWT_SECRET === DEFAULT_JWT_SECRET;
    const jwtSecretWeak = hasValue(cfg.JWT_SECRET) && String(cfg.JWT_SECRET).trim().length < 32;

    if (adminPassMissing) {
        warnings.push('ADMIN_PASS is missing. Dashboard login should be configured with an explicit password before production use.');
    } else if (adminPassDefault) {
        warnings.push('ADMIN_PASS is using the old default value. Replace it with a unique password.');
    }

    if (jwtSecretMissing) {
        warnings.push('JWT_SECRET is missing. Admin sessions cannot be signed securely until it is configured.');
    } else if (jwtSecretDefault) {
        warnings.push('JWT_SECRET is using the old default value. Replace it with a long random secret.');
    } else if (jwtSecretWeak) {
        warnings.push('JWT_SECRET is shorter than 32 characters. Use a longer secret for safer admin tokens.');
    }

    if (!hasValue(cfg.OWNER_NUMBER)) {
        warnings.push('OWNER_NUMBER is empty. Owner-only commands may not behave correctly.');
    }

    if (unsupportedNode) {
        warnings.push(`Node ${process.version} is outside the supported range (${supportedNodeRange}). Install a supported Node.js LTS release before starting the service.`);
    }

    const authConfigured = !adminPassMissing && !jwtSecretMissing;
    const credentialsHardened = !adminPassDefault && !jwtSecretDefault && !jwtSecretWeak;

    return {
        warnings,
        mode: {
            explicitMode,
            isProductionLike: explicitMode === 'production' && authConfigured && credentialsHardened && !unsupportedNode
        }
    };
}

module.exports = {
    validateConfig
};
