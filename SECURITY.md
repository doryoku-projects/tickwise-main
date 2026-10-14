# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through this repository's **Security** tab, using **Report a vulnerability** (GitHub private vulnerability reporting).

Include what you found, how to reproduce it, and what you think the impact is.

## What is in scope

- The code in this repository.
- The hosted API at `api.tickwise.xyz` and the site at `tickwise.xyz`, within these limits: no denial-of-service or load testing, no scraping beyond the documented limits, no access to other customers' data, and no social engineering of staff or customers.

## Secrets and deploying it yourself

This repository contains no live credentials. The values in `.env.example` and `docker-compose.yml` are placeholders for local development.

- The backend refuses to start in production while `JWT_SECRET`, `CUSTOMER_JWT_SECRET` or `ADMIN_SECRET` is a placeholder or shorter than 16 characters, and `CUSTOMER_JWT_SECRET` must differ from `JWT_SECRET`.
- It does **not** check `ADMIN_PASSWORD`. On the first start with no admin user it creates one from `ADMIN_EMAIL` and `ADMIN_PASSWORD`, so set your own strong values before the first production start.
- `docker-compose.yml` is for a local machine: it binds its ports to `127.0.0.1`, runs in development mode and carries placeholder secrets. Do not expose it.

If you find a real key or token anywhere in the code, report it as above.
