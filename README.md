# Roomdoku 🐼

Jogo puzzle competitivo online em tempo real para jogar em família e com amigos!

## Recursos
- **Multiplayer em tempo real** com salas por código e link de convite (Socket.IO)
- **Modo Solo** offline/online
- **Controles unificados mobile-first**:
  - 1 toque para marcar/desmarcar **✖️**
  - Arrastar o dedo para marcar vários quadrados com **✖️**
  - Duplo-toque rápido para confirmar o animal
- **PWA instalável** no Android e iPhone (quando hospedado em HTTPS)

---

## 🚀 Como subir no VPS

### Opção 1: Docker Compose (Mais rápido e recomendado)
No terminal do seu VPS (com Docker e Docker Compose instalados):
```bash
git clone https://github.com/gelsaum/roomdoku.git
cd roomdoku
docker compose up -d --build
```
O servidor ficará ouvindo na porta `3080` (sem conflitar com a `3000`) com healthcheck em `/health`. Caso queira usar outra porta no host, rode `HOST_PORT=4000 docker compose up -d --build`.

### Opção 2: Easypanel / Coolify / Dokploy
1. Crie um novo serviço/app apontando para o repositório GitHub `https://github.com/gelsaum/roomdoku.git` (branch `main`).
2. Escolha build via **Dockerfile**.
3. Configure a porta interna como `3080` (ou defina `PORT` nas variáveis de ambiente; o healthcheck `/health` se adapta automaticamente).
4. Associe o seu domínio com **HTTPS automático** (essencial para liberar o botão de instalar o PWA no celular).

### Opção 3: Node.js + PM2 + Nginx
Requer Node.js >= 18:
```bash
git clone https://github.com/gelsaum/roomdoku.git
cd roomdoku
npm ci --omit=dev
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
```
Em seguida, use o arquivo `nginx.conf.example` no `/etc/nginx/sites-available/roomdoku` (com suporte a WebSocket no `/`) e ative HTTPS com Certbot:
```bash
sudo certbot --nginx -d roomdoku.seudominio.com
```

### Variáveis de ambiente opcionais
- `PORT`: Porta do servidor (padrão `3080`; se já estiver ocupada ao rodar direto no Node, o servidor seleciona automaticamente a próxima porta disponível)
- `NODE_ENV`: `production` no VPS
- `PUBLIC_URL`: URL pública HTTPS (ex: `https://roomdoku.seudominio.com`), opcional caso queira fixar o domínio exibido nos convites

---

## 💻 Como rodar localmente
```bash
npm install
npm start
```
Acesse `http://localhost:3080` (ou a porta livre exibida no terminal).
