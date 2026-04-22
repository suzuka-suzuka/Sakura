import os from 'os';
import { logger } from './logger.js';

function isRestrictedNetworkInterfacesError(error) {
    return error?.code === 'ERR_SYSTEM_ERROR'
        && (error?.syscall === 'uv_interface_addresses'
            || error?.info?.syscall === 'uv_interface_addresses');
}

export function installOsCompatPatch() {
    const current = os.networkInterfaces;
    if (typeof current !== 'function' || current.__sakuraCompatPatched) {
        return;
    }

    const original = current.bind(os);
    let warned = false;

    function safeNetworkInterfaces() {
        try {
            return original();
        } catch (error) {
            if (!isRestrictedNetworkInterfacesError(error)) {
                throw error;
            }

            if (!warned) {
                warned = true;
                logger.warn(`[Compat] os.networkInterfaces() 在当前环境受限，已降级为空结果: ${error.message || error}`);
            }

            return {};
        }
    }

    safeNetworkInterfaces.__sakuraCompatPatched = true;
    safeNetworkInterfaces.__sakuraCompatOriginal = original;
    os.networkInterfaces = safeNetworkInterfaces;
}
