import { z } from "zod"

const optionalUrl = z.preprocess(value => value === '' ? undefined : value, z.url().optional())
const optionalName = z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional())

const zodEnv = z.object({
  AUTH_SECRET: z.string().min(32),
  AUTH_URL: optionalUrl,
  AUTHENTIK_ISSUER: optionalUrl,
  AUTHENTIK_CLIENT_ID: optionalName,
  AUTHENTIK_CLIENT_SECRET: optionalName,
  OIDC_ISSUER: optionalUrl,
  OIDC_CLIENT_ID: optionalName,
  OIDC_CLIENT_SECRET: optionalName,
  DEMO: z.string().optional(),
}).superRefine((env, context) => {
  const fields = [env.AUTHENTIK_ISSUER, env.AUTHENTIK_CLIENT_ID, env.AUTHENTIK_CLIENT_SECRET]
  if (fields.some(Boolean) && (!fields.every(Boolean) || !env.AUTH_URL)) {
    context.addIssue({ code: 'custom', message: 'Authentik requires AUTH_URL, AUTHENTIK_ISSUER, AUTHENTIK_CLIENT_ID, and AUTHENTIK_CLIENT_SECRET' })
  }
  const oidcFields = [env.OIDC_ISSUER, env.OIDC_CLIENT_ID, env.OIDC_CLIENT_SECRET]
  if (oidcFields.some(Boolean) && (!oidcFields.every(Boolean) || !env.AUTH_URL)) {
    context.addIssue({ code: 'custom', message: 'OIDC requires AUTH_URL, OIDC_ISSUER, OIDC_CLIENT_ID, and OIDC_CLIENT_SECRET' })
  }
  for (const [name, value] of [['AUTH_URL', env.AUTH_URL], ['AUTHENTIK_ISSUER', env.AUTHENTIK_ISSUER], ['OIDC_ISSUER', env.OIDC_ISSUER]]) {
    if (value && new URL(value).protocol !== 'https:' && process.env.NODE_ENV !== 'development') {
      context.addIssue({ code: 'custom', message: `${name} must use HTTPS in production` })
    }
  }
})

declare global {
  interface ProcessEnv extends z.TypeOf<typeof zodEnv> {
    AUTH_SECRET: string;
    AUTH_URL?: string;
    AUTHENTIK_ISSUER?: string;
    AUTHENTIK_CLIENT_ID?: string;
    AUTHENTIK_CLIENT_SECRET?: string;
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_CLIENT_SECRET?: string;
    DEMO?: string;
  }
}

export function init() {
  try {
    zodEnv.parse(process.env)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const { fieldErrors, formErrors } = err.flatten()
      const errorMessage = Object.entries(fieldErrors)
        .map(([field, errors]) =>
          Array.isArray(errors) ? `${field}: ${errors.join(", ")}` : field,
        )
        .concat(formErrors)
        .join("\n ")

      throw new Error(
        `Invalid environment variables:\n ${errorMessage}`,
      )
    }
  }
}
