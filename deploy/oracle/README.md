# Deploy Dossier on Oracle Cloud Always Free

This deployment uses one Ubuntu 24.04 ARM64 VM (OCI Ampere A1 Flex), Docker Compose, the Dossier production container, PostgreSQL and Caddy for HTTPS.

## Important: free-tier limits and reliability

- Always Free compute must be created in the tenancy's **home region**. Oracle currently documents the A1 Always Free allowance as 2 OCPUs and 12 GB RAM in total, plus 200 GB of combined boot/block-volume storage in the home region.
- The A1 VM is ARM64. This repository's CI image workflow therefore publishes both `linux/amd64` and `linux/arm64` images.
- A1 capacity may be unavailable in a region. Oracle says to retry another availability domain or wait if the console reports "out of host capacity".
- Oracle may reclaim an Always Free compute instance that remains idle under its published CPU, network and (for A1) memory thresholds for seven days. This is free-tier infrastructure, not a guaranteed production SLA. Maintain backups outside the VM.
- Stay within Always Free-labelled resources. Do not select paid shapes, paid boot/block storage, or paid load balancers.

Check Oracle's current official rules before provisioning:
https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm

## 1. Create the OCI account and VM

1. Create/sign in to an Oracle Cloud Free Tier account: https://www.oracle.com/cloud/free/
2. Choose your **home region** carefully. Always Free compute and block volume must be provisioned there.
3. In the OCI Console, create a Compute instance:
   - Image: Ubuntu 24.04, ARM64/AArch64.
   - Shape: `VM.Standard.A1.Flex`.
   - Always Free size: up to 2 OCPUs and 12 GB memory total.
   - Boot volume: start with the default 50 GB; verify the console labels the resources Always Free eligible.
   - Network: public subnet with a public IPv4 address.
   - SSH key: add the public key corresponding to the GitHub Actions deployment private key.
4. Under the VCN subnet security list or Network Security Group, add ingress rules:
   - TCP 22 from your own public IP only (recommended).
   - TCP 80 from `0.0.0.0/0`.
   - TCP 443 from `0.0.0.0/0`.
   - UDP 443 from `0.0.0.0/0` (optional HTTP/3).
5. Paste the contents of `deploy/oracle/cloud-init.yaml` into the instance's Custom cloud-init script field. Wait for cloud-init to finish.
6. Keep a note of the VM's public IPv4 address.

## 2. Configure a DNS name

Use a domain you control or a free dynamic-DNS hostname. Create an `A` record pointing to the VM public IPv4 address. Wait for DNS to resolve before deploying; Caddy needs a publicly reachable name to obtain a TLS certificate.

Set the final hostname as the GitHub secret `DOSSIER_DOMAIN` (for example, `dossier.example.com`). Do not use the placeholder hostname from the example.

## 3. Configure the GitHub deployment key

Generate a dedicated key pair on your computer (Git Bash, WSL or another OpenSSH terminal):

```bash
ssh-keygen -t ed25519 -C "github-actions-dossier" -f dossier_oci_deploy
```

- Add the contents of `dossier_oci_deploy.pub` to the Ubuntu user's authorized keys when creating the VM (or append it to `/home/ubuntu/.ssh/authorized_keys`).
- Store the **private** `dossier_oci_deploy` key only in the GitHub Actions secret `OCI_SSH_PRIVATE_KEY`.
- After the VM is live, run `ssh-keyscan -H YOUR_VM_PUBLIC_IP` and save its output as `OCI_KNOWN_HOSTS`. Verify the host fingerprint via a trusted channel before saving it.

## 4. Configure GitHub repository settings

Open Settings → Secrets and variables → Actions:
https://github.com/narendramohanmishraa/dossier/settings/secrets/actions

Create these **repository secrets**:

| Secret | Value |
|---|---|
| `OCI_HOST` | Oracle VM public IPv4 address |
| `OCI_USER` | `ubuntu` |
| `OCI_SSH_PRIVATE_KEY` | Private key from `dossier_oci_deploy` |
| `OCI_KNOWN_HOSTS` | Verified `ssh-keyscan -H` output |
| `DOSSIER_DOMAIN` | Public DNS hostname pointing to the VM |
| `POSTGRES_PASSWORD` | Random 32-byte hex password |
| `DOSSIER_PASSWORD_HASH` | Argon2id hash for the Dossier sign-in password |
| `DOSSIER_SECRET` | Random 48-byte hex secret |

Generate random values locally with:

```bash
openssl rand -hex 32
openssl rand -hex 48
```

Generate the Dossier password hash using the repository's `yarn hash-password` command in a secure local terminal. Do not paste passwords, private keys, tokens or hashes into chat or commit them to the repository.

Create this **repository variable**:

| Variable | Value |
|---|---|
| `DEPLOY_TO_OCI` | `true` |

The CI image workflow publishes the image to GitHub Container Registry (GHCR). Once the package is created, open the package's Package settings and make it Public so the OCI VM can pull it without storing a registry token on the server. The repository is public and the app is AGPL-licensed; do not put secrets in the image.

## 5. Run and verify deployment

After this PR is merged to `main` and the main-branch CI workflow succeeds:

- `.github/workflows/deploy-oci.yml` runs automatically.
- It connects to the Oracle VM over SSH, writes the production environment file from GitHub Secrets, pulls the exact commit-tagged multi-architecture GHCR image, and starts PostgreSQL, Dossier and Caddy.
- It then requests `https://YOUR_DOMAIN/api/health`. The release is marked successful only if the health endpoint returns `status: ok`, which includes a successful PostgreSQL query.

You can also manually redeploy from GitHub Actions → Deploy to Oracle Cloud and choose a published GHCR tag. The default is `main`.

Actions page:
https://github.com/narendramohanmishraa/dossier/actions

## 6. Backup and restore

- Dossier data and PostgreSQL data use named Docker volumes. They survive container restarts and image upgrades.
- Configure an off-VM backup schedule before storing important application data. The volume on the VM is not a backup.
- Never run `docker compose down -v` on production; it deletes the named volumes.
- Export your existing local Dossier data from Settings → Data before migration. Do not assume your laptop's Docker volumes are copied to Oracle.

## Current application-submission behaviour (read before enabling the job agent)

The job agent currently discovers, scores and prepares application drafts for review. Its "Approve" action promotes a candidate to a normal Dossier draft; it does **not** submit an external job application. The Chrome/Edge extension previews supported fields and fills only the fields selected by the user; it explicitly does not click Submit, upload documents, answer legal/eligibility questions or bypass CAPTCHA/OTP.

Therefore this deployment does **not** yet implement "one approval click then automatic ATS submission". External application submission is not a universal API and needs tested, per-ATS submission integrations plus an explicit final approval gate. Until that separate feature is built and verified, the final Submit action remains manual on the employer's site. No applications are submitted automatically by this release.
