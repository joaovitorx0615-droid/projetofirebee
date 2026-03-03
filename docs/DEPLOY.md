# Deploy e edicao por outra maquina

Este projeto pode ser editado em outra maquina e publicado no servidor com fluxo Git + systemd.

## Arquitetura recomendada
- **Maquina de desenvolvimento**: faz alteracoes e `git push` para `origin/main`.
- **Servidor**: faz `git pull`, instala dependencias e reinicia servico Node (`firebee.service`).

## 1) Preparar servidor (uma vez)
1. Instale prerequisitos:
```bash
sudo apt update
sudo apt install -y git rsync curl
```
2. Clone o repositorio no servidor:
```bash
sudo mkdir -p /opt
sudo chown "$USER":"$USER" /opt
git clone git@github.com:joaovitorx0615-droid/projetofirebee.git /opt/firebee
cd /opt/firebee
```
3. Configure ambiente:
```bash
cp .env.example .env
# edite .env com DB_HOST, DB_USER, DB_PASSWORD, DB_NAME etc.
```
4. Instale e suba o servico:
```bash
./scripts/install-systemd-service.sh firebee /opt/firebee
```

## 2) Editar de outra maquina
1. Na outra maquina, clone o repo e trabalhe normalmente.
2. Envie para `main`:
```bash
git add .
git commit -m "feat: ..."
git push origin main
```
3. No servidor, execute o deploy:
```bash
cd /opt/firebee
./scripts/deploy.sh
```

## 3) Opcional: deploy em um comando via SSH
Da maquina de desenvolvimento:
```bash
ssh usuario@IP_DO_SERVIDOR 'cd /opt/firebee && ./scripts/deploy.sh'
```

## 4) Verificacao
- Status do servico:
```bash
sudo systemctl status firebee --no-pager
```
- Logs:
```bash
sudo journalctl -u firebee -f
```
- Healthcheck:
```bash
curl -fsS http://127.0.0.1:3000/api/producao-status
```

## 5) Segurança minima recomendada
- Use chave SSH, desabilite senha no SSH quando possivel.
- Mantenha `.env` fora do Git.
- Restrinja acesso da porta da aplicacao via firewall/reverse proxy.
