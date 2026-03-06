import { expect, test, type Page } from '@playwright/test';

const mockMovies = [
  {
    id: 1,
    title: 'Mock Movie 1',
    year: 2024,
    rating: 9.1,
    poster: 'https://example.com/movie-1.jpg',
    genres: ['action'],
  },
  {
    id: 2,
    title: 'Mock Movie 2',
    year: 2023,
    rating: 8.7,
    poster: 'https://example.com/movie-2.jpg',
    genres: ['drama'],
  },
];

const mockUsers = [
  {
    id: 1,
    name: 'User Mock',
    age: 25,
    watched: [{ id: 1 }],
  },
];

async function installAppMocks(page: Page) {
  await page.route('**/api/movies', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockMovies),
    });
  });

  await page.route('**/api/users', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockUsers),
    });
  });

  await page.addInitScript(() => {
    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((error: ErrorEvent) => void) | null = null;
      onmessageerror: ((event: MessageEvent) => void) | null = null;

      constructor() {}

      postMessage(data: { action: string }) {
        if (data.action === 'train:model') {
          this.onmessage?.({
            data: {
              type: 'training:complete',
              stats: { movies: 2, users: 1 },
            },
          } as MessageEvent);
          return;
        }

        if (data.action === 'recommend') {
          this.onmessage?.({
            data: {
              type: 'recommend',
              recommendations: [{ id: 2, score: 0.96, confidence: 96 }],
            },
          } as MessageEvent);
        }
      }

      terminate() {}
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return false;
      }
    }

    // Replace worker globally before app scripts execute.
    (window as unknown as { Worker: typeof FakeWorker }).Worker = FakeWorker;
  });
}

test.describe('form flow', () => {
  test('happy path: submit form and update recommendation list', async ({ page }) => {
    await installAppMocks(page);
    await page.goto('/');

    await expect(page.locator('#results')).toContainText(/As recomenda[cç][oõ]es aparecer[aã]o aqui/i);

    await page.getByRole('button', { name: 'Treinar modelo' }).click();
    await expect(page.locator('#status')).toContainText(/Treinamento conclu[ií]do/i);

    await page.getByRole('spinbutton', { name: /Sua Idade/i }).fill('28');
    await page.getByRole('textbox', { name: /Filmes Assistidos/i }).fill('1');
    await page.getByRole('button', { name: 'Recomendar' }).click();

    await expect(page.getByRole('listitem')).toHaveCount(1);
    await expect(page.getByRole('listitem').first()).toContainText('Mock Movie 2');
  });

  test('invalid path: prevent submit for invalid age', async ({ page }) => {
    await installAppMocks(page);
    await page.goto('/');

    await page.getByRole('button', { name: 'Treinar modelo' }).click();
    await expect(page.locator('#status')).toContainText(/Treinamento conclu[ií]do/i);

    const ageInput = page.getByRole('spinbutton', { name: /Sua Idade/i });
    await ageInput.fill('0');
    await page.getByRole('textbox', { name: /Filmes Assistidos/i }).fill('1');
    await page.getByRole('button', { name: 'Recomendar' }).click();

    await expect
      .poll(async () => ageInput.evaluate((el: HTMLInputElement) => !el.checkValidity()))
      .toBe(true);
    await expect(page.getByRole('listitem')).toHaveCount(0);
    await expect(page.locator('#results')).toContainText(/As recomenda[cç][oõ]es aparecer[aã]o aqui/i);
  });
});
