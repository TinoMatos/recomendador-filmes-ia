### Como usar
1. Rode `npm start`.
2. O projeto sobe em `http://localhost:3001` e abre no Chrome automaticamente.
3. Clique em "Treinar modelo" e, depois, utilize o formulário para testar recomendações.

### Banco de dados (SQLite)
- O backend suporta dois modos:
	- `sqlite` (padrão local) em `data/movies.db`
	- `postgres` (produção)
- A interface carrega dados via API:
	- `GET /api/movies`
	- `GET /api/users`

### Usar PostgreSQL
Defina as variáveis antes de iniciar:

```bash
set DB_CLIENT=postgres
set DATABASE_URL=postgres://usuario:senha@localhost:5432/recomendacao_filmes
npm start
```

Se `DATABASE_URL` estiver definida, o servidor já usa PostgreSQL automaticamente.

### Importar base maior
Você pode importar arquivos JSON maiores com o mesmo formato atual:

```bash
npm run import:data -- caminho/para/movies.json caminho/para/users.json
```

Exemplo com os arquivos padrão:

```bash
npm run import:data
```

Também existem endpoints de carga em lote:
- `POST /api/movies/bulk`
- `POST /api/users/bulk`
