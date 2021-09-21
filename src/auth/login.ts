/* Copyright (c) 2021 Nordcloud Oy or its affiliates. All Rights Reserved. */

import { launch, Page } from "puppeteer";
import { authenticator } from "otplib";

const defaultBrowserOptons = {
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
};

type Credentials = {
  email: string;
  password: string;
};

type LoginParams = {
  browserOptions?: typeof defaultBrowserOptons;
  credentials: Credentials;
  loginUrl: string;
  otpSecret: string;
};

export async function login({
  browserOptions = defaultBrowserOptons,
  credentials,
  loginUrl,
  otpSecret,
}: LoginParams) {
  const browser = await launch(browserOptions);

  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(loginUrl);

    // Enter credentials.
    await writeUsername({ page, value: credentials.email });
    await writePassword({ page, value: credentials.password });

    const response = await submit({ page });

    if ((response?.status() ?? 0) >= 400) {
      throw new Error(`'Login with user ${credentials.email} failed, error ${response?.status()}`);
    }

    const url = response?.url();

    // handle MFA code
    if (url?.includes("/mf")) {
      const token = authenticator.generate(otpSecret);

      await writeMfa({ page, value: token });
      await checkCheckbox({ page });

      const redirectResponse = await submit({ page });
      const redirectUrl = redirectResponse?.url();

      // Now let's fetch all cookies.
      // @ts-expect-error We are using an internal api here
      const { cookies } = await page._client.send("Network.getAllCookies", {});

      return {
        callbackUrl: redirectUrl,
        cookies,
      };
    }

    throw new Error(`Redirect to the MFA page failed`);
  } finally {
    await page.close();
    await browser.close();
  }
}

type HelperArgs = { page: Page; value: string };

async function writeUsername({ page, value }: HelperArgs) {
  await page.waitForSelector("input[type=text]", { visible: true });
  await page.type("input[type=text]", value);
  await page.click("button[type=submit]");
}

async function writePassword({ page, value }: HelperArgs) {
  await page.waitForSelector("input[type=password]", { visible: true });
  await page.type("input[type=password]", value);
}

async function submit({ page }: Omit<HelperArgs, "value">) {
  await page.waitForSelector("button[type=submit]", {
    visible: true,
    timeout: 5000,
  });

  const [response] = await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click("button[type=submit]"),
  ]);
  return response;
}

async function writeMfa({ page, value }: HelperArgs) {
  await page.waitForSelector("input[type=text]", { visible: true });
  await page.type("input[type=text]", value);
}

async function checkCheckbox({ page }: Omit<HelperArgs, "value">) {
  await page.click("input[type=checkbox]");
}
