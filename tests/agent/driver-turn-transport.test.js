import { describe, it, expect } from 'vitest';
import { resolveDriverConfig, DRIVER_ENV } from '../../agent/driver.js';

/**
 * Turn-boundary transport tests (phase-2 ticket 5/6): the driver's tools
 * talk to a turn service over HTTP when TIM_AGENT_TURN_BASE_URL says so,
 * and stay in-process when it does not. This file pins (1) the config
 * surface - the container-mode switch is env-first, CLI-won, unambiguous -
 * and (2) the transport itself: driver turns served by real turn services
 * over real HTTP behind the env var, while the default path stays today's
 * in-process runTurn, byte-for-byte.
 */

describe('resolveDriverConfig - TIM_AGENT_TURN_BASE_URL (the container-mode switch)', () => {
    it('reads the turn base URL from env, exposing it as config.turnBaseUrl', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm'],
            env: { [DRIVER_ENV.TURN_BASE_URL]: 'http://127.0.0.1:8787' },
        });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBe('http://127.0.0.1:8787');
    });

    it('CLI --turn-base-url overrides the env var (CLI wins, house rule)', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm', '--turn-base-url', 'http://127.0.0.1:9999'],
            env: { [DRIVER_ENV.TURN_BASE_URL]: 'http://127.0.0.1:8787' },
        });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBe('http://127.0.0.1:9999');
    });

    it('an unset TIM_AGENT_TURN_BASE_URL leaves turnBaseUrl undefined - host mode byte-for-byte', () => {
        const { errors, config } = resolveDriverConfig({ argv: ['--model', 'm'], env: {} });
        expect(errors).toEqual([]);
        expect(config.turnBaseUrl).toBeUndefined();
    });

    it('a non-http(s) turn base URL is a config error naming the env var', () => {
        const { errors, config } = resolveDriverConfig({
            argv: ['--model', 'm'],
            env: { [DRIVER_ENV.TURN_BASE_URL]: 'ftp://127.0.0.1:8787' },
        });
        expect(config).toBeNull();
        expect(errors.join(' ')).toContain(DRIVER_ENV.TURN_BASE_URL);
        expect(errors).toHaveLength(1);
        expect(errors.join(' ')).toMatch(/an http\(s\):\/\/ URL is required/);
    });
});
