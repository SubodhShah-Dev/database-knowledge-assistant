# Auth API

Source: `apps/backend/src/routes/auth.routes.ts`

## `POST /api/auth/signup`

Creates a user and returns a JWT.

### Request

```json
{ "email": "user@example.com", "password": "at-least-8-characters" }
```

### Behavior

- Trims and lowercases the email.
- Requires a basic email shape and a password of at least 8 characters.
- Hashes the password with bcrypt.
- Inserts a `users` row with the default `user` role.
- Returns the safe user and a 2-hour JWT.

### Responses

| Status | Meaning |
| --- | --- |
| `201` | User created |
| `400` | Invalid email or password |
| `409` | Email already registered |

```json
{
  "user": { "id": "uuid", "email": "user@example.com", "role": "user" },
  "token": "jwt"
}
```

### Client path

`apps/frontend/src/api/client.ts:103` → `AuthContext.tsx:36` → `LoginPage.tsx:46`.

## `POST /api/auth/login`

Verifies credentials and returns a JWT.

### Request

```json
{ "email": "user@example.com", "password": "..." }
```

### Behavior

- Looks up the user by normalized email.
- Compares the password with the stored bcrypt hash.
- Removes `password_hash` before responding.
- Signs a 2-hour JWT with `sub` and `role`.

### Responses

| Status | Meaning |
| --- | --- |
| `200` | Authenticated |
| `401` | Invalid email or password |

```json
{
  "user": { "id": "uuid", "email": "user@example.com", "role": "user" },
  "token": "jwt"
}
```

### Client path

`apps/frontend/src/api/client.ts:96` → `AuthContext.tsx:28` → `LoginPage.tsx:45`.

## Token use

Protected requests send:

```http
Authorization: Bearer <jwt>
```

`requireAuth` verifies the token, requires a string `sub`, and attaches:

```ts
req.user = { id: payload.sub, role: payload.role ?? 'user' };
```

Invalid or expired tokens return `401`.

## Related docs

- [API index](./README.md)
- [Application database](../databases/application-database.md)
