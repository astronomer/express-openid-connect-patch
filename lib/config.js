const Joi = require('joi');
const crypto = require('crypto');
const { defaultState: getLoginState } = require('./hooks/getLoginState');
const isHttps = /^https:/i;

const defaultSessionIdGenerator = () => crypto.randomBytes(16).toString('hex');

const paramsSchema = Joi.object({
  secret: Joi.alternatives([
    Joi.string().min(8),
    Joi.binary().min(8),
    Joi.array().items(Joi.string().min(8), Joi.binary().min(8)),
  ]).required(),
  session: Joi.object({
    rolling: Joi.boolean().optional().default(true),
    rollingDuration: Joi.when(Joi.ref('rolling'), {
      is: true,
      then: Joi.number().integer().messages({
        'number.base':
          '"session.rollingDuration" must be provided an integer value when "session.rolling" is true',
      }),
      otherwise: Joi.boolean().valid(false).messages({
        'any.only':
          '"session.rollingDuration" must be false when "session.rolling" is disabled',
      }),
    })
      .optional()
      .default((parent) => (parent.rolling ? 24 * 60 * 60 : false)), // 1 day when rolling is enabled, else false
    absoluteDuration: Joi.when(Joi.ref('rolling'), {
      is: false,
      then: Joi.number().integer().messages({
        'number.base':
          '"session.absoluteDuration" must be provided an integer value when "session.rolling" is false',
      }),
      otherwise: Joi.alternatives([
        Joi.number().integer(),
        Joi.boolean().valid(false),
      ]),
    })
      .optional()
      .default(7 * 24 * 60 * 60), // 7 days,
    name: Joi.string()
      .pattern(/^[0-9a-zA-Z_.-]+$/, { name: 'cookie name' })
      .optional()
      .default('appSession'),
    store: Joi.object()
      .optional()
      .when(Joi.ref('/backchannelLogout'), {
        not: false,
        then: Joi.when('/backchannelLogout.store', {
          not: Joi.exist(),
          then: Joi.when('/backchannelLogout.isLoggedOut', {
            not: Joi.exist(),
            then: Joi.object().required().messages({
              'any.required': `Back-Channel Logout requires a "backchannelLogout.store" (you can also reuse "session.store" if you have stateful sessions) or custom hooks for "isLoggedOut" and "onLogoutToken".`,
            }),
          }),
        }),
      }),
    genid: Joi.function()
      .maxArity(1)
      .optional()
      .default(() => defaultSessionIdGenerator),
    signSessionStoreCookie: Joi.boolean().optional().default(false),
    requireSignedSessionStoreCookie: Joi.boolean()
      .optional()
      .default(Joi.ref('signSessionStoreCookie')),
    cookie: Joi.object({
      domain: Joi.string().optional(),
      transient: Joi.boolean().optional().default(false),
      httpOnly: Joi.boolean().optional().default(true),
      sameSite: Joi.string()
        .valid('Lax', 'Strict', 'None')
        .optional()
        .default('Lax'),
      secure: Joi.when(Joi.ref('/baseURL'), {
        is: Joi.string().pattern(isHttps),
        then: Joi.boolean()
          .default(true)
          .custom((value, { warn }) => {
            if (!value) warn('insecure.cookie');
            return value;
          })
          .messages({
            'insecure.cookie':
              "Setting your cookie to insecure when over https is not recommended, I hope you know what you're doing.",
          }),
        otherwise: Joi.boolean().valid(false).default(false).messages({
          'any.only':
            'Cookies set with the `Secure` property wont be attached to http requests',
        }),
      }),
      path: Joi.string().uri({ relativeOnly: true }).optional(),
    })
      .default()
      .unknown(false),
  })
    .default()
    .unknown(false),
  transactionCookie: Joi.object({
    sameSite: Joi.string()
      .valid('Lax', 'Strict', 'None')
      .optional()
      .default(Joi.ref('...session.cookie.sameSite')),
    name: Joi.string().optional().default('auth_verification'),
  })
    .default()
    .unknown(false),
  auth0Logout: Joi.boolean().optional(),
  tokenEndpointParams: Joi.object().optional(),
  issuer: Joi.object().required().unknown(true).default(),
  authorizationParams: Joi.object({
    response_type: Joi.string()
      .optional()
      .valid('id_token', 'code id_token', 'code')
      .default('id_token'),
    scope: Joi.string()
      .optional()
      .pattern(/\bopenid\b/, 'contains openid')
      .default('openid profile email'),
    response_mode: Joi.string()
      .optional()
      .when('response_type', {
        is: 'code',
        then: Joi.valid('query', 'form_post'),
        otherwise: Joi.valid('form_post').default('form_post'),
      }),
  })
    .optional()
    .unknown(true)
    .default(),
  logoutParams: Joi.object().optional(),
  backchannelLogout: Joi.alternatives([
    Joi.object({
      store: Joi.object().optional(),
      onLogin: Joi.alternatives([
        Joi.function(),
        Joi.boolean().valid(false),
      ]).optional(),
      isLoggedOut: Joi.alternatives([
        Joi.function(),
        Joi.boolean().valid(false),
      ]).optional(),
      onLogoutToken: Joi.function().optional(),
    }),
    Joi.boolean(),
  ]).default(false),
  baseURL: Joi.string()
    .uri()
    .required()
    .when(Joi.ref('authorizationParams.response_mode'), {
      is: 'form_post',
      then: Joi.string().pattern(isHttps).rule({
        warn: true,
        message: `Using 'form_post' for response_mode may cause issues for you logging in over http, see https://github.com/auth0/express-openid-connect/blob/master/FAQ.md`,
      }),
    }),
  clientID: Joi.string().required(),
  clientSecret: Joi.string()
    .when(
      Joi.ref('clientAuthMethod', {
        adjust: (value) => value && value.includes('client_secret'),
      }),
      {
        is: true,
        then: Joi.string().required().messages({
          'any.required': `"clientSecret" is required for the "clientAuthMethod" "{{clientAuthMethod}}"`,
        }),
      }
    )
    .when(
      Joi.ref('idTokenSigningAlg', {
        adjust: (value) => value && value.startsWith('HS'),
      }),
      {
        is: true,
        then: Joi.string().required().messages({
          'any.required':
            '"clientSecret" is required for ID tokens with HMAC based algorithms',
        }),
      }
    ),
  clockTolerance: Joi.number().optional().default(60),
  enableTelemetry: Joi.boolean().optional().default(true),
  errorOnRequiredAuth: Joi.boolean().optional().default(false),
  attemptSilentLogin: Joi.boolean().optional().default(false),
  getLoginState: Joi.function()
    .optional()
    .default(() => getLoginState),
  afterCallback: Joi.function().optional(),
  identityClaimFilter: Joi.array()
    .optional()
    .default([
      'aud',
      'iss',
      'iat',
      'exp',
      'nbf',
      'nonce',
      'azp',
      'auth_time',
      's_hash',
      'at_hash',
      'c_hash',
    ]),
  idpLogout: Joi.boolean()
    .optional()
    .default((parent) => parent.auth0Logout || false),
  idTokenSigningAlg: Joi.string()
    .insensitive()
    .not('none')
    .optional()
    .default('RS256'),
  issuerBaseURL: Joi.string().uri().required(),
  legacySameSiteCookie: Joi.boolean().optional().default(true),
  authRequired: Joi.boolean().optional().default(true),
  pushedAuthorizationRequests: Joi.boolean().optional().default(false),
  routes: Joi.object({
    login: Joi.alternatives([
      Joi.string().uri({ relativeOnly: true }),
      Joi.boolean().valid(false),
    ]).default('/login'),
    logout: Joi.alternatives([
      Joi.string().uri({ relativeOnly: true }),
      Joi.boolean().valid(false),
    ]).default('/logout'),
    callback: Joi.alternatives([
      Joi.string().uri({ relativeOnly: true }),
      Joi.boolean().valid(false),
    ]).default('/callback'),
    postLogoutRedirect: Joi.string().uri({ allowRelative: true }).default(''),
    backchannelLogout: Joi.string()
      .uri({ allowRelative: true })
      .default('/backchannel-logout'),
  })
    .default()
    .unknown(false),
  clientAuthMethod: Joi.string()
    .valid(
      'client_secret_basic',
      'client_secret_post',
      'client_secret_jwt',
      'private_key_jwt',
      'none'
    )
    .optional()
    .default((parent) => {
      if (
        parent.authorizationParams.response_type === 'id_token' &&
        !parent.pushedAuthorizationRequests
      ) {
        return 'none';
      }
      if (parent.clientAssertionSigningKey) {
        return 'private_key_jwt';
      }
      return 'client_secret_basic';
    })
    .when(
      Joi.ref('authorizationParams.response_type', {
        adjust: (value) => value && value.includes('code'),
      }),
      {
        is: true,
        then: Joi.string().invalid('none').messages({
          'any.only': 'Public code flow clients are not supported.',
        }),
      }
    )
    .when(Joi.ref('pushedAuthorizationRequests'), {
      is: true,
      then: Joi.string().invalid('none').messages({
        'any.only': 'Public PAR clients are not supported.',
      }),
    }),
  clientAssertionSigningKey: Joi.any()
    .optional()
    .when(Joi.ref('clientAuthMethod'), {
      is: 'private_key_jwt',
      then: Joi.any().required().messages({
        'any.required':
          '"clientAssertionSigningKey" is required for a "clientAuthMethod" of "private_key_jwt"',
      }),
    }), // <Object> | <string> | <Buffer> | <KeyObject>,
  clientAssertionSigningAlg: Joi.string()
    .valid(
      'RS256',
      'RS384',
      'RS512',
      'PS256',
      'PS384',
      'PS512',
      'ES256',
      'ES256K',
      'ES384',
      'ES512',
      'EdDSA'
    )
    .optional(),
  discoveryCacheMaxAge: Joi.number()
    .optional()
    .min(0)
    .default(10 * 60 * 1000),
  httpTimeout: Joi.number().optional().min(500).default(5000),
  httpUserAgent: Joi.string().optional(),
  httpAgent: Joi.object().optional(),
});

module.exports.get = function (config = {}) {
  config = {
    secret: process.env.SECRET,
    issuerBaseURL: process.env.ISSUER_BASE_URL,
    baseURL: process.env.BASE_URL,
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    ...config,
  };

  const { value, error, warning } = paramsSchema.validate(config);
  if (error) {
    throw new TypeError(error.details[0].message);
  }
  if (warning) {
    console.warn(warning.message);
  }
  return value;
};
