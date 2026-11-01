import type { Queryable } from '@seatlock/db';

export type Role = 'USER' | 'ADMIN';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: Role;
  created_at: Date;
}

export async function insertUser(
  db: Queryable,
  input: { name: string; email: string; passwordHash: string },
): Promise<UserRow> {
  const { rows } = await db.query<UserRow>(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING *`,
    [input.name, input.email, input.passwordHash],
  );
  return rows[0]!;
}

export async function findUserByEmail(db: Queryable, email: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
  return rows[0];
}

export async function findUserById(db: Queryable, id: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0];
}
