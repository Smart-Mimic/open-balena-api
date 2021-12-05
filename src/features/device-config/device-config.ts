import type { Request } from 'express';
import * as fs from 'fs';
import * as _ from 'lodash';

import type { Option as DeviceTypeOption } from '@resin.io/device-types';
import { errors } from '@balena/pinejs';
import * as semver from 'balena-semver';
import * as deviceConfig from 'balena-device-config';

import { getUser } from '../../infra/auth/auth';
import { captureException } from '../../infra/error-handling';

import {
	ApiKeyOptions,
	createProvisioningApiKey,
	createUserApiKey,
} from '../api-keys/lib';
import type { DeviceType } from '../device-types/device-types';

const { BadRequestError } = errors;

// FIXME(refactor): many of the following are resin-specific
import {
	API_HOST,
	DELTA_HOST,
	MIXPANEL_TOKEN,
	NODE_EXTRA_CA_CERTS,
	REGISTRY2_HOST,
	VPN_HOST,
	VPN_PORT,
} from '../../lib/config';

// `osVersion == null` means assume "latest"
export const generateConfig = async (
	req: Request,
	app: deviceConfig.GenerateOptions['application'],
	deviceType: DeviceType,
	osVersion?: string,
) => {
	const userPromise = getUser(req);

	// Devices running ResinOS >=1.2.1 are capable of using Registry v2, while earlier ones must use v1
	if (osVersion != null && semver.lte(osVersion, '1.2.0')) {
		throw new BadRequestError(
			'balenaOS versions <= 1.2.0 are no longer supported, please update',
		);
	}
	const registryHost = REGISTRY2_HOST;

	const apiKeyPromise = (async () => {
		// Devices running ResinOS >= 2.7.8 can use provisioning keys
		if (osVersion != null && semver.satisfies(osVersion, '<2.7.8')) {
			// Older ones have to use the old "user api keys"
			return await createUserApiKey(req, (await userPromise).id);
		}

		const apiKeyOptions: ApiKeyOptions = {};

		// Checking both req.body and req.query given both GET and POST support
		// Ref: https://github.com/balena-io/balena-api/blob/master/src/routes/applications.ts#L95
		const keyName: string | undefined =
			req.body.provisioningKeyName ??
			req.query.provisioningKeyName ??
			undefined;

		const expiryDate: string | undefined =
			req.body.provisioningKeyExpiry ??
			req.query.provisioningKeyExpiry ??
			undefined;

		if (typeof keyName === 'string') {
			apiKeyOptions.name = keyName;
		}

		if (typeof expiryDate === 'string') {
			apiKeyOptions.expiryDate = new Date(expiryDate);
		}

		return await createProvisioningApiKey(req, app.id, apiKeyOptions);
	})();

	// There may be multiple CAs, this doesn't matter as all will be passed in the config
	const selfSignedRootPromise = (async () => {
		const caFile = NODE_EXTRA_CA_CERTS;
		if (!caFile) {
			return;
		}
		try {
			await fs.promises.stat(caFile);
			const pem = await fs.promises.readFile(caFile, 'utf8');
			return Buffer.from(pem).toString('base64');
		} catch (err) {
			if (err.code !== 'ENOENT') {
				captureException(err, 'Self-signed root CA could not be read');
			}
		}
	})();

	const user = await userPromise;
	const apiKey = await apiKeyPromise;
	const rootCA = await selfSignedRootPromise;

	const config = deviceConfig.generate(
		{
			application: app,
			deviceType: deviceType.slug,
			user,
			apiKey,
			mixpanel: {
				token: MIXPANEL_TOKEN,
			},
			vpnPort: VPN_PORT,
			endpoints: {
				api: `https://${API_HOST}`,
				delta: `https://${DELTA_HOST}`,
				registry: registryHost,
				vpn: VPN_HOST,
			},
			version: osVersion,
		},
		{
			appUpdatePollInterval:
				parseInt(req.param('appUpdatePollInterval'), 10) * 60 * 1000,
			network: req.body.network ?? req.query.network,
			wifiSsid: req.param('wifiSsid'),
			wifiKey: req.param('wifiKey'),
			ip: req.param('ip'),
			gateway: req.param('gateway'),
			netmask: req.param('netmask'),
		},
	);

	_(deviceType.options!)
		.flatMap((opt): DeviceTypeOption[] | DeviceTypeOption => {
			if ('isGroup' in opt && opt.isGroup) {
				if (['network', 'advanced'].includes(opt.name)) {
					// already handled above
					return [];
				} else {
					return opt.options;
				}
			} else {
				return opt;
			}
		})
		.each(({ name: optionName }) => {
			config[optionName] = req.param(optionName);
		});
	if (rootCA != null) {
		config.balenaRootCA = rootCA;
	}

	const developmentMode =
		osVersion === 'latest' ? undefined : osVersion?.endsWith('.dev');
	if (developmentMode != null) {
		config.developmentMode = developmentMode;
	}

	return config;
};
