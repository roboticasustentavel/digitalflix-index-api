// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import { PrismaClient } from "./generated/prisma/index.js";
// Se estiver usando @prisma/client direto, troque a linha acima por:
// import { PrismaClient } from "@prisma/client";

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "digitalflix";

// ------------------------- HEALTH ------------------------- //
app.get("/", (_req, res) => {
  res.send("API de Filmes rodando...");
});

// ------------------------- AUTH --------------------------- //
// Registro de usuário
app.post("/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ error: "Campos obrigatórios: name, email, password." });
    }

    // email é unique no schema; isso lança erro se já existir
    const user = await prisma.user.create({
      data: { name, email, password, role: role ?? "user" },
    });

    res.status(201).json({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    console.error(err);
    // conflito de unique
    if (String(err?.code) === "P2002") {
      return res.status(409).json({ error: "E-mail já cadastrado." });
    }
    res.status(500).json({ error: "Erro ao registrar usuário." });
  }
});

// Login
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res
        .status(400)
        .json({ error: "Campos obrigatórios: email, password." });

    // Busca por e-mail (unique)
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || user.password !== password) {
      return res.status(401).json({ error: "Credenciais inválidas." });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.status(200).json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao efetuar login." });
  }
});

// ------------------------- MOVIES ------------------------- //
// GET /movies - lista com filtros simples (search em genre/description) e paginação
app.get("/movies", async (req, res) => {
  try {
    const {
      search,
      page = "1",
      pageSize = "10",
      featured,
      minRating,
      maxRating,
      year,
    } = req.query;

    const where = {};

    if (search && String(search).trim()) {
      where.OR = [
        { genre: { contains: String(search), mode: "insensitive" } },
        { description: { contains: String(search), mode: "insensitive" } },
      ];
    }

    if (featured !== undefined) {
      const val =
        typeof featured === "string"
          ? featured.toLowerCase() === "true"
          : Boolean(featured);
      where.featured = val;
    }

    if (minRating && !Number.isNaN(Number(minRating))) {
      where.rating = { ...(where.rating || {}), gte: Number(minRating) };
    }
    if (maxRating && !Number.isNaN(Number(maxRating))) {
      where.rating = { ...(where.rating || {}), lte: Number(maxRating) };
    }
    if (year && !Number.isNaN(Number(year))) {
      where.year = Number(year);
    }

    const take = Math.max(1, Math.min(100, Number(pageSize)));
    const skip = (Math.max(1, Number(page)) - 1) * take;

    const [items, total] = await Promise.all([
      prisma.movies.findMany({
        where,
        skip,
        take,
        orderBy: { year: "desc" },
      }),
      prisma.movies.count({ where }),
    ]);

    res.json({
      page: Number(page),
      pageSize: take,
      total,
      totalPages: Math.ceil(total / take),
      items,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao listar filmes." });
  }
});

// GET /movies/:id - obtém um filme por id (ObjectId em string)
app.get("/movies/:id", async (req, res) => {
  try {
    const movie = await prisma.movies.findUnique({
      where: { id: req.params.id },
    });
    if (!movie) return res.status(404).json({ error: "Filme não encontrado." });
    res.json(movie);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: "ID inválido." });
  }
});

// POST /movies - cria um filme
// Body: { genre, rating, image, featured, description, year, trailerUrl }
app.post("/movies", async (req, res) => {
  try {
    const {
      genre,
      rating,
      image,
      featured = false,
      description,
      year,
      trailerUrl,
    } = req.body;

    // validações básicas
    if (!genre || typeof genre !== "string")
      return res.status(400).json({ error: "genre é obrigatório (string)." });
    if (typeof rating !== "number")
      return res.status(400).json({ error: "rating é obrigatório (number)." });
    if (!image || typeof image !== "string")
      return res
        .status(400)
        .json({ error: "image é obrigatório (string URL)." });
    if (!description || typeof description !== "string")
      return res
        .status(400)
        .json({ error: "description é obrigatório (string)." });
    if (typeof year !== "number")
      return res.status(400).json({ error: "year é obrigatório (number)." });
    if (!trailerUrl || typeof trailerUrl !== "string")
      return res
        .status(400)
        .json({ error: "trailerUrl é obrigatório (string URL)." });

    const created = await prisma.movies.create({
      data: {
        genre,
        rating,
        image,
        featured: !!featured,
        description,
        year,
        trailerUrl,
      },
    });

    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao criar filme." });
  }
});

// PUT /movies/:id - atualiza parcial/total
app.put("/movies/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { genre, rating, image, featured, description, year, trailerUrl } =
      req.body;

    const data = {};
    if (genre !== undefined) data.genre = genre;
    if (rating !== undefined) data.rating = rating;
    if (image !== undefined) data.image = image;
    if (featured !== undefined) data.featured = !!featured;
    if (description !== undefined) data.description = description;
    if (year !== undefined) data.year = year;
    if (trailerUrl !== undefined) data.trailerUrl = trailerUrl;

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "Nenhum campo para atualizar." });
    }

    const updated = await prisma.movies.update({
      where: { id },
      data,
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    if (String(err?.code) === "P2025") {
      return res.status(404).json({ error: "Filme não encontrado." });
    }
    res
      .status(400)
      .json({ error: "Erro ao atualizar filme (verifique o ID e os campos)." });
  }
});

// DELETE /movies/:id - remove um filme
app.delete("/movies/:id", async (req, res) => {
  try {
    const deleted = await prisma.movies.delete({
      where: { id: req.params.id },
    });
    res.json({ message: "Filme removido com sucesso.", id: deleted.id });
  } catch (err) {
    console.error(err);
    if (String(err?.code) === "P2025") {
      return res.status(404).json({ error: "Filme não encontrado." });
    }
    res.status(400).json({ error: "Erro ao remover filme (ID inválido?)." });
  }
});

// ------------------------- START ------------------------- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor ouvindo em http://localhost:${PORT}`);
});
