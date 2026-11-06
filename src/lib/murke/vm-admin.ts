/**
 * murke vm admin code + admin app pwd — shared between the shell commands
 * and anything else that needs to compare them. Kept in one tiny module so
 * the values live in exactly one place.
 */

/** The vm command's provisioning/deletion gate (masked ** prompt). */
export const VM_ADMIN_CODE = "310554";
