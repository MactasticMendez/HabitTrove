import { z } from "zod"

const zodEnv = z.object({
  AUTH_SECRET: z.string().min(32),
  DEMO: z.string().optional(),
})

declare global {
  interface ProcessEnv extends z.TypeOf<typeof zodEnv> {
    AUTH_SECRET: string;
    DEMO?: string;
  }
}

export function init() {
  try {
    zodEnv.parse(process.env)
  } catch (err) {
    if (err instanceof z.ZodError) {
      const { fieldErrors } = err.flatten()
      const errorMessage = Object.entries(fieldErrors)
        .map(([field, errors]) =>
          Array.isArray(errors) ? `${field}: ${errors.join(", ")}` : field,
        )
        .join("\n ")

      throw new Error(
        `Invalid environment variables:\n ${errorMessage}`,
      )
    }
  }
}
