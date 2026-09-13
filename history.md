# jsonstor-redis
[`@liquicode/jsonstor-redis`](https://github.com/liquicode/jsonstor-redis)


# Project History


v0.2.0 (current)
---------------------------------------------------------------------

***First release.***

The adapter for Redis and Valkey. It keeps an index over the primary key, so a criteria
  naming one identifier reads one document. Tested on Redis 6.2, 7.2 and 8.10 and Valkey 7.2
  and 8.1.

- Built on `@liquicode/jsonstor` 0.2.0 and `@liquicode/jsongin` 0.2.0. A criteria the engine
  refuses is refused before the storage acts on it.
- The TLS settings are `Encrypt` and `TrustServerCertificate`.
- Declares Node.js `>=20.0.0` in `engines`.
