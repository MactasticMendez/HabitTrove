import { email, literal, object, string } from "zod"

export const emailSchema = email().max(254)

export const usernameSchema = string()
  .min(3, "Username must be at least 3 characters")
  .max(20, "Username must be less than 20 characters")
  .regex(/^[a-zA-Z0-9]+$/, "Username must be alphanumeric")

export const passwordSchema = string()
  .min(4, "Password must be more than 4 characters")
  .max(128, "Password must be at most 128 characters")
  .optional()
  .or(literal(''))

export const newPasswordSchema = string()
  .min(12, "Password must be at least 12 characters")
  .max(128, "Password must be at most 128 characters")

export const signInSchema = object({
  username: usernameSchema,
  password: passwordSchema,
})
