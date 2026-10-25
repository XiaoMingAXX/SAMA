import {
  randomBytes,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
export const scrypt = promisify(scryptCallback);
export const now = () => new Date().toISOString();
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export class AppError extends Error {
  constructor(message, status = 400, code = "VALIDATION") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function check(value, message, status = 400) {
  if (!value) throw new AppError(message, status);
}
export function text(value, max = 200, required = false) {
  check(
    typeof value === "string" || value === undefined || value === null,
    "Text required",
  );
  const v = String(value ?? "").trim();
  check(
    v.length <= max && (!required || v.length > 0),
    `Text must contain ${required ? "1" : "0"}–${max} characters`,
  );
  return v;
}
export function integer(value, min, max) {
  const v = Number(value);
  check(
    Number.isSafeInteger(v) && v >= min && v <= max,
    `Integer ${min}–${max} required`,
  );
  return v;
}
export function date(value, fallback = null) {
  if (!value) return fallback;
  check(
    typeof value === "string" &&
      /^\d{4}-\d\d-\d\dT/.test(value) &&
      Number.isFinite(Date.parse(value)),
    "ISO datetime required",
  );
  return new Date(value).toISOString();
}
export function username(value) {
  const v = text(value, 40, true).toLowerCase();
  check(
    /^[a-z0-9][a-z0-9_.-]{2,39}$/.test(v),
    "Username: 3–40 letters, digits, dot, dash or underscore",
  );
  return v;
}
export async function passwordHash(password) {
  check(
    typeof password === "string" &&
      password.length >= 10 &&
      password.length <= 128,
    "Password must be 10–128 characters",
  );
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password, stored) {
  if (typeof password !== "string" || password.length > 128) return false;
  const [salt, expected] = (
    stored || `${"0".repeat(32)}:${"0".repeat(128)}`
  ).split(":");
  const key = await scrypt(password, salt, 64);
  const hash = Buffer.from(expected, "hex");
  return hash.length === key.length && timingSafeEqual(key, hash);
}
export function safeUser(row) {
  if (!row) return null;
  const { password_hash, ...user } = row;
  return user;
}
