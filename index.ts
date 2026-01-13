import * as lwk from "lwk_wasm"
import {
    setWollet, getWollet,
    setCurrencyCode, getCurrencyCode,
    setPricesFetcher, getPricesFetcher,
    setEsploraClient, getEsploraClient,
    setBoltzSession, getBoltzSession,
    setInvoiceResponse,
    setExchangeRate, getExchangeRate,
    setWasmReady, isWasmReady,
    subscribe
} from './state'

// Constants
const SATOSHIS_PER_BTC: number = 100_000_000;
const RATE_UPDATE_INTERVAL_MS: number = 60_000; // 1 minute
const LOCALSTORAGE_FORM_KEY: string = 'btcpos_setup_form';

// =============================================================================
// Plausible Analytics
// =============================================================================

// Declare plausible function type (loaded from external script)
declare function plausible(eventName: string, options?: { props?: Record<string, string | number> }): void;

function trackEvent(eventName: string, props?: Record<string, string | number>): void {
    if (typeof plausible === 'function') {
        plausible(eventName, props ? { props } : undefined);
    }
}

// Convert satoshi amount to privacy-preserving bucket label
function satoshiBucket(satoshis: number): string {
    if (satoshis < 1_000) return '0-1k';           // ~$0-$1 (micro)
    if (satoshis < 10_000) return '1k-10k';        // ~$1-$10 (small)
    if (satoshis < 100_000) return '10k-100k';     // ~$10-$100 (medium)
    if (satoshis < 1_000_000) return '100k-1M';    // ~$100-$1k (large)
    return '1M+';                                   // ~$1k+ (very large)
}

// Network configuration (hardcoded to mainnet)
const network: lwk.Network = lwk.Network.mainnet();

// Esplora/Waterfalls configuration
const MAINNET_WATERFALLS_URL = "https://waterfalls.liquidwebwallet.org/liquid/api";
const TESTNET_WATERFALLS_URL = "https://waterfalls.liquidwebwallet.org/liquidtestnet/api";
const WATERFALLS_RECIPIENT_KEY = "age1xxzrgrfjm3yrwh3u6a7exgrldked0pdauvr3mx870wl6xzrwm5ps8s2h0p";

// Reference to main app container
const app: HTMLElement = document.getElementById('app')!;

// Rate update interval handle
let rateUpdateInterval: number | null = null;

// =============================================================================
// URL-safe Base64 Encoding/Decoding
// =============================================================================

function base64UrlEncode(str: string): string {
    const base64 = btoa(str);
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function base64UrlDecode(str: string): string {
    // Add padding back
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return atob(base64);
}

// =============================================================================
// Configuration Encoding/Decoding
// =============================================================================

interface POSConfig {
    d: string; // descriptor
    c: string; // currency code (alpha3)
    g?: boolean; // show gear (optional, defaults to false)
    n?: boolean; // show note/description (optional, defaults to true)
}

function encodeConfig(descriptor: string, currency: string, showGear: boolean, showDescription: boolean): string {
    const config: POSConfig = { d: descriptor, c: currency };
    // Only include 'g' if true to keep URL shorter when false (default)
    if (showGear) {
        config.g = true;
    }
    // Only include 'n' if false to keep URL shorter when true (default)
    if (!showDescription) {
        config.n = false;
    }
    return base64UrlEncode(JSON.stringify(config));
}

function decodeConfig(encoded: string): POSConfig | null {
    try {
        const json = base64UrlDecode(encoded);
        const config = JSON.parse(json) as POSConfig;
        if (typeof config.d !== 'string' || typeof config.c !== 'string') {
            return null;
        }
        // Default showGear to false if not present
        if (typeof config.g !== 'boolean') {
            config.g = false;
        }
        // Default showDescription to true if not present
        if (typeof config.n !== 'boolean') {
            config.n = true;
        }
        return config;
    } catch {
        return null;
    }
}

// =============================================================================
// LocalStorage helpers
// =============================================================================

function saveFormToLocalStorage(descriptor: string, currency: string, showGear: boolean, showDescription: boolean): void {
    try {
        localStorage.setItem(LOCALSTORAGE_FORM_KEY, JSON.stringify({ descriptor, currency, showGear, showDescription }));
    } catch {
        // Ignore storage errors
    }
}

function loadFormFromLocalStorage(): { descriptor: string; currency: string; showGear: boolean; showDescription: boolean } | null {
    try {
        const data = localStorage.getItem(LOCALSTORAGE_FORM_KEY);
        if (data) {
            const parsed = JSON.parse(data);
            // Handle old format without showGear
            if (typeof parsed.showGear !== 'boolean') {
                parsed.showGear = false;
            }
            // Handle old format without showDescription
            if (typeof parsed.showDescription !== 'boolean') {
                parsed.showDescription = true;
            }
            return parsed;
        }
    } catch {
        // Ignore storage errors
    }
    return null;
}

// =============================================================================
// Template Rendering
// =============================================================================

function renderTemplate(templateId: string): void {
    const template = document.getElementById(templateId) as HTMLTemplateElement;
    if (!template) {
        console.error(`Template ${templateId} not found`);
        return;
    }
    app.innerHTML = '';
    app.appendChild(template.content.cloneNode(true));
}

// =============================================================================
// Exchange Rate Fetching
// =============================================================================

async function fetchExchangeRate(): Promise<void> {
    const currencyCode = getCurrencyCode();
    const pricesFetcher = getPricesFetcher();

    if (!currencyCode || !pricesFetcher) {
        return;
    }

    try {
        const rates = await pricesFetcher.rates(currencyCode);
        const median = rates.median();
        setExchangeRate(median);

        // Update UI
        const rateValue = document.getElementById('rate-value');
        if (rateValue) {
            rateValue.textContent = median.toLocaleString('en-US', {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
            });
        }
    } catch (e) {
        console.error('Failed to fetch exchange rate:', e);
    }
}

function startRateUpdates(): void {
    // Fetch immediately
    fetchExchangeRate();

    // Then fetch every minute
    if (rateUpdateInterval) {
        clearInterval(rateUpdateInterval);
    }
    rateUpdateInterval = window.setInterval(fetchExchangeRate, RATE_UPDATE_INTERVAL_MS);
}

function stopRateUpdates(): void {
    if (rateUpdateInterval) {
        clearInterval(rateUpdateInterval);
        rateUpdateInterval = null;
    }
}

// =============================================================================
// Fiat to Satoshi Conversion
// =============================================================================

function fiatToSatoshis(fiatAmount: number): number {
    const rate = getExchangeRate();
    if (!rate || rate <= 0) {
        return 0;
    }

    const btcAmount = fiatAmount / rate;
    return Math.round(btcAmount * SATOSHIS_PER_BTC);
}

// =============================================================================
// Esplora Client with Waterfalls
// =============================================================================

async function createEsploraClient(): Promise<lwk.EsploraClient> {
    const url = network.isMainnet() ? MAINNET_WATERFALLS_URL : TESTNET_WATERFALLS_URL;
    const waterfalls = true;
    const concurrency = 4;
    const utxoOnly = true;

    const client = new lwk.EsploraClient(network, url, waterfalls, concurrency, utxoOnly);

    // Set the waterfalls server recipient key for encryption
    if (waterfalls && (network.isMainnet() || network.isTestnet())) {
        await client.setWaterfallsServerRecipient(WATERFALLS_RECIPIENT_KEY);
    }

    return client;
}

// =============================================================================
// Mnemonic Export (for Boltz recovery)
// =============================================================================

/**
 * Downloads the Boltz session mnemonic as a JSON file for swap recovery.
 * The file format is compatible with boltz.exchange recovery tool.
 * @param dwid - The wallet's DWID to look up the mnemonic
 */
function downloadMnemonicJson(dwid: string): void {
    const mnemonicKey = `btcpos-mnemonic-${dwid}`;
    const mnemonic = localStorage.getItem(mnemonicKey);

    if (!mnemonic) {
        console.warn('No mnemonic found for this wallet');
        alert('No recovery data available for this wallet.');
        return;
    }

    // Create JSON in Boltz-compatible format
    const recoveryData = JSON.stringify({ mnemonic }, null, 0);

    // Create and trigger download
    const blob = new Blob([recoveryData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `btcpos-recovery-${dwid}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    console.log('Mnemonic JSON downloaded for recovery');
}

/**
 * Sets up a triple-click handler on an element to trigger mnemonic export.
 * @param element - The element to attach the handler to
 * @param getDwid - Function to get the current DWID
 */
function setupMnemonicExportTrigger(element: HTMLElement, getDwid: () => string | null): void {
    let clickCount = 0;
    let clickTimer: number | null = null;
    const TRIPLE_CLICK_TIMEOUT = 500; // ms

    element.addEventListener('click', () => {
        clickCount++;

        if (clickTimer) {
            clearTimeout(clickTimer);
        }

        if (clickCount === 3) {
            clickCount = 0;
            const dwid = getDwid();
            if (dwid) {
                downloadMnemonicJson(dwid);
            }
        } else {
            clickTimer = window.setTimeout(() => {
                clickCount = 0;
            }, TRIPLE_CLICK_TIMEOUT);
        }
    });

}

// =============================================================================
// Boltz Session
// =============================================================================

async function createBoltzSession(wollet: lwk.Wollet, esploraClient: lwk.EsploraClient): Promise<lwk.BoltzSession> {
    const dwid = wollet.dwid();
    const mnemonicKey = `btcpos-mnemonic-${dwid}`;

    // Check if mnemonic exists in localStorage
    let mnemonic: lwk.Mnemonic;
    const storedMnemonic = localStorage.getItem(mnemonicKey);

    if (storedMnemonic) {
        // Load existing mnemonic
        mnemonic = new lwk.Mnemonic(storedMnemonic);
        console.log(`Found Boltz mnemonic in localStorage at key ${mnemonicKey}`);
    } else {
        // Create new random mnemonic and save it
        console.log(`No mnemonic found in localStorage at key ${mnemonicKey}, creating new random mnemonic`);
        mnemonic = lwk.Mnemonic.fromRandom(12);
        localStorage.setItem(mnemonicKey, mnemonic.toString());
    }

    let boltzSessionBuilder = new lwk.BoltzSessionBuilder(network, esploraClient);
    boltzSessionBuilder = boltzSessionBuilder.mnemonic(mnemonic);
    boltzSessionBuilder = boltzSessionBuilder.referralId("btcpos");

    const session = await boltzSessionBuilder.build();
    return session;
}

// =============================================================================
// Setup Page
// =============================================================================

function initSetupPage(): void {
    renderTemplate('setup-page-template');

    const form = document.getElementById('setup-form') as HTMLFormElement;
    const descriptorInput = document.getElementById('descriptor') as HTMLTextAreaElement;
    const currencySelect = document.getElementById('currency') as HTMLSelectElement;
    const showGearCheckbox = document.getElementById('show-gear') as HTMLInputElement;
    const showDescriptionCheckbox = document.getElementById('show-description') as HTMLInputElement;
    const generateButton = document.getElementById('generate-link') as HTMLButtonElement;
    const messageDiv = document.getElementById('setup-message') as HTMLDivElement;
    const wasmStatus = document.getElementById('wasm-status') as HTMLDivElement;
    const generatedSection = document.getElementById('generated-link-section') as HTMLDivElement;
    const generatedLinkInput = document.getElementById('generated-link') as HTMLInputElement;
    const copyButton = document.getElementById('copy-link') as HTMLButtonElement;
    const qrImage = document.getElementById('qr-image') as HTMLImageElement;
    const qrLink = document.getElementById('qr-link') as HTMLAnchorElement;
    const openPosLink = document.getElementById('open-pos-link') as HTMLAnchorElement;

    // Load saved form data
    const savedForm = loadFormFromLocalStorage();
    if (savedForm) {
        descriptorInput.value = savedForm.descriptor;
        currencySelect.value = savedForm.currency;
        showGearCheckbox.checked = savedForm.showGear;
        showDescriptionCheckbox.checked = savedForm.showDescription;
    }

    // Update WASM status
    function updateWasmStatus(ready: boolean): void {
        const indicator = wasmStatus.querySelector('.status-indicator') as HTMLElement;
        const text = wasmStatus.querySelector('.status-text') as HTMLElement;

        if (ready) {
            indicator.classList.remove('loading');
            indicator.classList.add('ready');
            text.textContent = 'WASM loaded';
            generateButton.disabled = false;
        } else {
            indicator.classList.add('loading');
            indicator.classList.remove('ready');
            text.textContent = 'Loading WASM module...';
            generateButton.disabled = true;
        }
    }

    // Subscribe to WASM ready state
    subscribe('wasm-ready', updateWasmStatus);
    updateWasmStatus(isWasmReady());

    // Show message
    function showMessage(text: string, isError: boolean): void {
        messageDiv.textContent = text;
        messageDiv.className = 'message ' + (isError ? 'error' : 'success');
    }

    function clearMessage(): void {
        messageDiv.className = 'message';
        messageDiv.textContent = '';
    }

    // Form submission
    form.addEventListener('submit', async (e: Event) => {
        e.preventDefault();
        clearMessage();

        const descriptor = descriptorInput.value.trim();
        const currency = currencySelect.value;
        const showGear = showGearCheckbox.checked;
        const showDescription = showDescriptionCheckbox.checked;

        if (!descriptor) {
            showMessage('Please enter a CT descriptor', true);
            return;
        }

        // Validate descriptor using LWK
        try {
            generateButton.disabled = true;
            generateButton.textContent = 'Validating...';

            // This will throw if the descriptor is invalid
            const wolletDescriptor = new lwk.WolletDescriptor(descriptor);
            const descriptorReEncoded = wolletDescriptor.toString(); // Re-encode desctiptor because aqua/green can give non-multipath longer version
            // Check if descriptor matches network
            const isMainnet = wolletDescriptor.isMainnet();
            const networkIsMainnet = network.isMainnet();

            if (isMainnet !== networkIsMainnet) {
                showMessage(
                    `Descriptor is for ${isMainnet ? 'mainnet' : 'testnet'}, but POS is configured for ${networkIsMainnet ? 'mainnet' : 'testnet'}`,
                    true
                );
                generateButton.disabled = false;
                generateButton.textContent = 'Generate POS Link';
                return;
            }

            // Save form data
            saveFormToLocalStorage(descriptorReEncoded, currency, showGear, showDescription);

            // Generate the link
            const encoded = encodeConfig(descriptorReEncoded, currency, showGear, showDescription);
            const baseUrl = window.location.origin + window.location.pathname;
            const posLink = `${baseUrl}#${encoded}`;

            // Show the generated link
            generatedLinkInput.value = posLink;
            openPosLink.href = posLink;

            // Generate QR code
            const qrUri = lwk.stringToQr(posLink);
            qrImage.src = qrUri;
            qrLink.href = posLink;

            generatedSection.hidden = false;

            // Track successful POS link generation
            trackEvent('Generate POS Link', { currency: currency });

            showMessage('POS link generated successfully!', false);
        } catch (e) {
            showMessage(`Invalid descriptor: ${e}`, true);
        } finally {
            generateButton.disabled = false;
            generateButton.textContent = 'Generate POS Link';
        }
    });

    // Copy link button
    copyButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(generatedLinkInput.value);
            copyButton.textContent = '✓';
            setTimeout(() => {
                copyButton.textContent = '📋';
            }, 2000);
        } catch {
            // Fallback: select the input
            generatedLinkInput.select();
            document.execCommand('copy');
        }
    });

    // Open POS link tracking
    openPosLink.addEventListener('click', () => {
        trackEvent('Open POS');
    });
}

// =============================================================================
// POS Page
// =============================================================================

function initPosPage(config: POSConfig): void {
    renderTemplate('pos-page-template');

    // Save config for returning from receive page
    currentPosConfig = config;

    // POS state
    let currentAmount: string = '0';
    let inputMode: 'fiat' | 'sats' = 'fiat';
    const currencyAlpha3 = config.c;

    // Get DOM elements
    const amountDisplay = document.getElementById('amount') as HTMLSpanElement;
    const satoshiDisplay = document.getElementById('satoshi-amount') as HTMLSpanElement;
    const currencyCodeDisplay = document.getElementById('currency-code') as HTMLSpanElement;
    const rateCurrencyDisplay = document.getElementById('rate-currency') as HTMLSpanElement;
    const descriptionInput = document.getElementById('description') as HTMLInputElement;
    const submitButton = document.getElementById('submit') as HTMLButtonElement;
    const walletIdDisplay = document.getElementById('wallet-id') as HTMLSpanElement;
    const setupLink = document.getElementById('setup-link') as HTMLAnchorElement;
    const wasmStatus = document.getElementById('wasm-status') as HTMLDivElement;
    const modeFiatButton = document.getElementById('mode-fiat') as HTMLButtonElement;
    const modeSatsButton = document.getElementById('mode-sats') as HTMLButtonElement;
    const primaryDisplay = document.getElementById('primary-display') as HTMLDivElement;
    const secondaryDisplay = document.getElementById('secondary-display') as HTMLDivElement;

    // Show/hide setup gear based on config
    if (!config.g) {
        setupLink.style.display = 'none';
    }

    // Show/hide description field based on config
    const descriptionSection = descriptionInput.parentElement as HTMLDivElement;
    if (!config.n) {
        descriptionSection.style.display = 'none';
    }

    // Set fixed currency
    currencyCodeDisplay.textContent = currencyAlpha3;
    rateCurrencyDisplay.textContent = currencyAlpha3;

    // Setup link to go back
    setupLink.addEventListener('click', (e: Event) => {
        e.preventDefault();
        stopRateUpdates();
        history.pushState(null, '', window.location.pathname);
        initSetupPage();
    });

    // Convert satoshis to fiat
    function satoshisToFiat(satoshis: number): number {
        const rate = getExchangeRate();
        if (!rate || rate <= 0) {
            return 0;
        }
        const btcAmount = satoshis / SATOSHIS_PER_BTC;
        return btcAmount * rate;
    }

    // Update display styling based on mode
    function updateDisplayStyles(): void {
        if (inputMode === 'fiat') {
            primaryDisplay.classList.remove('secondary-mode');
            primaryDisplay.classList.add('primary-mode');
            secondaryDisplay.classList.remove('primary-mode');
            secondaryDisplay.classList.add('secondary-mode');
            modeFiatButton.classList.add('active');
            modeSatsButton.classList.remove('active');
        } else {
            primaryDisplay.classList.add('secondary-mode');
            primaryDisplay.classList.remove('primary-mode');
            secondaryDisplay.classList.add('primary-mode');
            secondaryDisplay.classList.remove('secondary-mode');
            modeFiatButton.classList.remove('active');
            modeSatsButton.classList.add('active');
        }
    }

    // Format display
    function formatDisplay(): void {
        if (currentAmount === '' || currentAmount === '0') {
            amountDisplay.textContent = '0.00';
            satoshiDisplay.textContent = '0';
            return;
        }

        // Remove leading zeros except if it's just "0" or "0."
        if (currentAmount.startsWith('0') && currentAmount.length > 1 && currentAmount[1] !== '.') {
            currentAmount = currentAmount.replace(/^0+/, '');
        }

        const amount = parseFloat(currentAmount);

        if (inputMode === 'fiat') {
            // Input is fiat, calculate sats
            amountDisplay.textContent = currentAmount;
            if (!isNaN(amount) && amount > 0) {
                const satoshis = fiatToSatoshis(amount);
                satoshiDisplay.textContent = satoshis.toLocaleString('en-US');
            } else {
                satoshiDisplay.textContent = '0';
            }
        } else {
            // Input is sats, calculate fiat
            satoshiDisplay.textContent = currentAmount.includes('.')
                ? currentAmount.split('.')[0]
                : currentAmount;
            if (!isNaN(amount) && amount > 0) {
                const satoshis = Math.floor(amount); // Sats are whole numbers
                const fiat = satoshisToFiat(satoshis);
                amountDisplay.textContent = fiat.toFixed(2);
            } else {
                amountDisplay.textContent = '0.00';
            }
        }
    }

    // Handle input
    function handleInput(value: string): void {
        // In sats mode, don't allow decimal points (sats are integers)
        if (inputMode === 'sats' && value === '.') {
            return;
        }

        // Prevent multiple decimal points
        if (value === '.' && currentAmount.includes('.')) {
            return;
        }

        // Limit decimal places based on mode
        if (currentAmount.includes('.')) {
            const decimalPart = currentAmount.split('.')[1];
            const maxDecimals = inputMode === 'fiat' ? 2 : 0;
            if (decimalPart && decimalPart.length >= maxDecimals && value !== '.') {
                return;
            }
        }

        // Limit total length
        if (currentAmount.length >= 12) {
            return;
        }

        if (currentAmount === '0' && value !== '.') {
            currentAmount = value;
        } else {
            currentAmount += value;
        }

        formatDisplay();
    }

    // Handle backspace
    function handleBackspace(): void {
        if (currentAmount.length <= 1) {
            currentAmount = '0';
        } else {
            currentAmount = currentAmount.slice(0, -1);
        }
        formatDisplay();
    }

    // Handle clear
    function handleClear(): void {
        currentAmount = '0';
        formatDisplay();
    }

    // Get final satoshi amount based on current mode
    function getFinalSatoshis(): number {
        const amount = parseFloat(currentAmount);
        if (isNaN(amount) || amount <= 0) {
            return 0;
        }
        if (inputMode === 'fiat') {
            return fiatToSatoshis(amount);
        } else {
            return Math.floor(amount);
        }
    }

    // Get final fiat amount based on current mode
    function getFinalFiat(): number {
        const amount = parseFloat(currentAmount);
        if (isNaN(amount) || amount <= 0) {
            return 0;
        }
        if (inputMode === 'fiat') {
            return amount;
        } else {
            return satoshisToFiat(Math.floor(amount));
        }
    }

    // Handle submit
    async function handleSubmit() {
        const satoshis = getFinalSatoshis();
        const fiatAmount = getFinalFiat();
        const description = descriptionInput.value.trim();

        if (satoshis <= 0) {
            alert('Please enter a valid amount greater than 0');
            return;
        }

        // Show loading state on button
        submitButton.disabled = true;
        const originalText = submitButton.textContent;
        submitButton.innerHTML = '<span class="button-loading"><span class="spinner"></span>Creating...</span>';

        try {
            // Invoice data (will be used for Boltz integration later)
            const invoiceData = {
                fiatAmount: fiatAmount,
                currency: currencyAlpha3,
                satoshis: satoshis,
                description: description || null,
                timestamp: new Date().toISOString()
            };

            console.log('Invoice data:', invoiceData);
            const claimAddress = await getClaimAddress();
            console.log('Claim address:', claimAddress.toString());

            const invoice = await getBoltzSession().invoice(BigInt(satoshis), description, claimAddress);
            console.log('Invoice:', invoice.bolt11Invoice().toString());
            setInvoiceResponse(invoice);

            // Track invoice creation (using bucket for privacy)
            trackEvent('Create Invoice', { amount: satoshiBucket(satoshis), currency: currencyAlpha3 });

            // Navigate to receive page
            initReceivePage(invoice, satoshis, fiatAmount, currencyAlpha3);

            // Reset amount for next payment
            currentAmount = '0';
        } catch (e) {
            console.error('Failed to create invoice:', e);
            alert(`Failed to create invoice: ${e}`);
            // Restore button state
            submitButton.disabled = false;
            submitButton.textContent = originalText;
        }
    }

    // Remove trailing zeros from a number string (e.g., "123.40" -> "123.4", "123.00" -> "123")
    function removeTrailingZeros(numStr: string): string {
        if (!numStr.includes('.')) return numStr;
        // Remove trailing zeros after decimal point
        let result = numStr.replace(/\.?0+$/, '');
        // If we removed everything after decimal, result might be empty or just the integer
        return result || '0';
    }

    // Mode toggle handlers
    modeFiatButton.addEventListener('click', () => {
        if (inputMode !== 'fiat') {
            // Convert current sats to fiat
            const satoshis = getFinalSatoshis();
            inputMode = 'fiat';
            if (satoshis > 0) {
                const fiat = satoshisToFiat(satoshis);
                // Remove trailing zeros so user can continue typing
                currentAmount = removeTrailingZeros(fiat.toFixed(2));
            } else {
                currentAmount = '0';
            }
            updateDisplayStyles();
            formatDisplay();
        }
    });

    modeSatsButton.addEventListener('click', () => {
        if (inputMode !== 'sats') {
            // Convert current fiat to sats
            const satoshis = getFinalSatoshis();
            inputMode = 'sats';
            currentAmount = satoshis > 0 ? satoshis.toString() : '0';
            updateDisplayStyles();
            formatDisplay();
        }
    });

    // Keypad event listeners
    document.querySelectorAll('.key[data-value]').forEach((button: Element) => {
        button.addEventListener('click', () => {
            handleInput((button as HTMLButtonElement).dataset.value!);
        });
    });

    document.getElementById('backspace')!.addEventListener('click', handleBackspace);
    document.getElementById('clear')!.addEventListener('click', handleClear);
    submitButton.addEventListener('click', handleSubmit);

    // Keyboard input
    document.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.target === descriptionInput) {
            return;
        }

        if (e.key >= '0' && e.key <= '9') {
            handleInput(e.key);
        } else if (e.key === '.') {
            handleInput('.');
        } else if (e.key === 'Backspace') {
            e.preventDefault();
            handleBackspace();
        } else if (e.key === 'Escape') {
            handleClear();
        } else if (e.key === 'Enter') {
            handleSubmit();
        }
    });

    // Update status text helper
    function updateStatusText(text: string): void {
        const statusText = wasmStatus.querySelector('.status-text') as HTMLElement;
        if (statusText) {
            statusText.textContent = text;
        }
    }

    // Initialize async parts (wallet, esplora client, boltz session, exchange rate)
    async function initWalletAsync(): Promise<void> {
        try {
            // Check if we already have a valid session in state
            let esploraClient = getEsploraClient();
            let wollet = getWollet();
            let boltzSession = getBoltzSession();

            // If all components exist and wallet descriptor matches, reuse them
            if (esploraClient && wollet && boltzSession) {
                const existingDwid = wollet.dwid();
                const newDescriptor = new lwk.WolletDescriptor(config.d);
                const newWollet = new lwk.Wollet(network, newDescriptor);
                const newDwid = newWollet.dwid();

                if (existingDwid === newDwid) {
                    console.log('Reusing existing wallet and Boltz session');
                    walletIdDisplay.textContent = existingDwid;

                    // Start rate updates (in case they were stopped)
                    startRateUpdates();

                    // Hide loading status
                    wasmStatus.classList.add('hidden');
                    return;
                }
                // Different descriptor, need to reinitialize
                console.log('Descriptor changed, reinitializing...');
            }

            updateStatusText('Creating Esplora client...');

            // Create Esplora client with waterfalls
            esploraClient = await createEsploraClient();
            setEsploraClient(esploraClient);
            console.log('Esplora client created with waterfalls');

            updateStatusText('Initializing wallet...');

            // Create wallet descriptor and wallet
            const wolletDescriptor = new lwk.WolletDescriptor(config.d);
            wollet = new lwk.Wollet(network, wolletDescriptor);
            await syncWallet(wollet);
            setWollet(wollet);

            // Show full wallet ID at bottom
            const dwid = wollet.dwid();
            walletIdDisplay.textContent = dwid;
            console.log(`Wallet initialized with DWID: ${dwid}`);

            // Setup triple-click on wallet ID to export mnemonic for recovery
            setupMnemonicExportTrigger(walletIdDisplay, () => wollet.dwid());

            updateStatusText('Creating Boltz session...');

            // Create Boltz session for lightning swaps
            boltzSession = await createBoltzSession(wollet, esploraClient);
            setBoltzSession(boltzSession);
            console.log('Boltz session created');

            // Initialize currency and price fetcher
            const currencyCode = new lwk.CurrencyCode(currencyAlpha3);
            setCurrencyCode(currencyCode);

            const pricesFetcher = new lwk.PricesFetcher();
            setPricesFetcher(pricesFetcher);

            // Start rate updates
            startRateUpdates();

            // Hide loading status
            wasmStatus.classList.add('hidden');
            console.log('POS fully initialized');
        } catch (e) {
            console.error('Failed to initialize wallet:', e);
            const indicator = wasmStatus.querySelector('.status-indicator') as HTMLElement;
            const text = wasmStatus.querySelector('.status-text') as HTMLElement;
            indicator.classList.remove('loading');
            indicator.classList.add('error');
            text.textContent = `Error: ${e}`;
        }
    }

    // Subscribe to rate changes to update display and enable button
    subscribe('exchange-rate-changed', () => {
        formatDisplay();
        // Enable submit button once we have an exchange rate
        const rate = getExchangeRate();
        if (rate && rate > 0) {
            submitButton.disabled = false;
        }
    });

    // Initialize when WASM is ready
    if (isWasmReady()) {
        initWalletAsync();
    } else {
        subscribe('wasm-ready', (ready: boolean) => {
            if (ready) {
                initWalletAsync();
            }
        });
    }

    // Initialize display styles and values
    updateDisplayStyles();
    formatDisplay();
}

// =============================================================================
// Complete Pay Background Task
// =============================================================================

/**
 * Spawn a background task to complete a swap payment
 * @param invoice - The InvoiceResponse from Boltz
 * @param onComplete - Callback when payment completes
 */
function spawnCompletePay(invoice: lwk.InvoiceResponse, onComplete: (success: boolean) => void): void {
    setTimeout(async () => {
        try {
            console.log("Starting completePay in background...");
            const swapId = invoice.swapId();
            console.log("Swap ID:", swapId);
            const completed = await invoice.completePay();
            console.log("completePay finished with result:", completed);
            onComplete(completed);
        } catch (error) {
            console.error("Error in completePay:", error);
            onComplete(false);
        }
    }, 0);
}

// =============================================================================
// Receive Page
// =============================================================================

// Store the current config for returning to POS
let currentPosConfig: POSConfig | null = null;

function initReceivePage(invoice: lwk.InvoiceResponse, satoshis: number, fiatAmount: number, currencyAlpha3: string): void {
    renderTemplate('receive-page-template');

    // Get DOM elements
    const receiveSats = document.getElementById('receive-sats') as HTMLSpanElement;
    const receiveFiat = document.getElementById('receive-fiat') as HTMLSpanElement;
    const invoiceQr = document.getElementById('invoice-qr') as HTMLImageElement;
    const invoiceQrLink = document.getElementById('invoice-qr-link') as HTMLAnchorElement;
    const invoiceText = document.getElementById('invoice-text') as HTMLTextAreaElement;
    const copyInvoiceButton = document.getElementById('copy-invoice') as HTMLButtonElement;
    const backToPosButton = document.getElementById('back-to-pos') as HTMLButtonElement;
    const walletIdDisplay = document.getElementById('wallet-id') as HTMLSpanElement;
    const wasmStatus = document.getElementById('wasm-status') as HTMLDivElement;
    const statusIndicator = wasmStatus.querySelector('.status-indicator') as HTMLElement;
    const statusText = wasmStatus.querySelector('.status-text') as HTMLElement;

    // Get the bolt11 invoice
    const bolt11 = invoice.bolt11Invoice().toString();

    // Display amounts
    receiveSats.textContent = `${satoshis.toLocaleString('en-US')} sats`;
    receiveFiat.textContent = `≈ ${currencyAlpha3} ${fiatAmount.toFixed(2)}`;

    // Generate QR code with lightning: prefix and uppercase bolt11
    const lightningUri = `lightning:${bolt11.toUpperCase()}`;
    const qrUri = lwk.stringToQr(lightningUri);
    invoiceQr.src = qrUri;
    invoiceQrLink.href = lightningUri;

    // Display invoice text (lowercase for copy/paste)
    invoiceText.value = bolt11;

    // Show wallet ID and setup triple-click for mnemonic export
    const wollet = getWollet();
    if (wollet) {
        const dwid = wollet.dwid();
        walletIdDisplay.textContent = dwid;
        setupMnemonicExportTrigger(walletIdDisplay, () => dwid);
    }

    // Copy invoice button
    copyInvoiceButton.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(bolt11);
            copyInvoiceButton.textContent = '✓';
            setTimeout(() => {
                copyInvoiceButton.textContent = '📋';
            }, 2000);
        } catch {
            invoiceText.select();
            document.execCommand('copy');
        }
    });

    // Back to POS button
    backToPosButton.addEventListener('click', () => {
        // Clear the invoice
        setInvoiceResponse(null);
        // Return to POS page
        if (currentPosConfig) {
            initPosPage(currentPosConfig);
        }
    });

    // Spawn background task to wait for payment completion
    spawnCompletePay(invoice, (success: boolean) => {
        if (success) {
            // Payment completed successfully
            statusIndicator.classList.remove('loading');
            statusIndicator.classList.add('ready');
            statusText.textContent = 'Payment received!';
            backToPosButton.textContent = '✓ New Payment';
            backToPosButton.classList.remove('secondary-button');

            // Track successful payment (using bucket for privacy)
            trackEvent('Payment Received', { amount: satoshiBucket(satoshis), currency: currencyAlpha3 });

            // Replace QR code with checkmark SVG
            const checkmarkSvg = `data:image/svg+xml,${encodeURIComponent(`
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
                    <circle cx="100" cy="100" r="90" fill="#22c55e"/>
                    <path d="M60 100 L90 130 L140 70" stroke="white" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                </svg>
            `)}`;
            invoiceQr.classList.add('payment-success');
            invoiceQr.src = checkmarkSvg;
        } else {
            // Payment failed or timed out
            statusIndicator.classList.remove('loading');
            statusIndicator.classList.add('error');
            statusText.textContent = 'Payment failed or expired';
        }
    });
}

// =============================================================================
// Error Page
// =============================================================================

function initErrorPage(message: string): void {
    renderTemplate('error-page-template');

    const errorMessage = document.getElementById('error-message') as HTMLParagraphElement;
    errorMessage.textContent = message;
}

// =============================================================================
// Router
// =============================================================================

function route(): void {
    // Check hash first (privacy-preserving), then query string (for PWA install)
    const hash = window.location.hash.slice(1); // Remove the '#'
    const query = window.location.search.slice(1); // Remove the '?'
    const configString = hash || query;

    if (!configString) {
        // No config = setup page
        initSetupPage();
        return;
    }

    // Try to decode the config
    const config = decodeConfig(configString);

    if (!config) {
        initErrorPage('The provided link is invalid or malformed. The configuration data could not be decoded.');
        return;
    }

    // Validate descriptor (basic check - full validation happens in POS page)
    if (!config.d || config.d.length < 10) {
        initErrorPage('The provided link is missing a valid descriptor.');
        return;
    }

    if (!config.c || config.c.length !== 3) {
        initErrorPage('The provided link is missing a valid currency code.');
        return;
    }

    // Show POS page
    initPosPage(config);
}

async function getClaimAddress(): Promise<lwk.Address> {
    const wollet = getWollet();
    syncWallet(wollet);
    const claimAddress = wollet.address(null).address();
    return claimAddress;
}

async function syncWallet(wollet: lwk.Wollet): Promise<void> {
    const client = getEsploraClient();
    const update = await client.fullScan(wollet);
    if (update) {
        wollet.applyUpdate(update);
    }
}

// =============================================================================
// Main Initialization
// =============================================================================

async function init(): Promise<void> {
    console.log('Bitcoin POS initializing...');

    // Route to correct page immediately (before WASM loads)
    route();

    // Handle hash changes (browser back/forward)
    window.addEventListener('hashchange', () => {
        stopRateUpdates();
        route();
    });

    // Mark WASM as ready
    setWasmReady(true);
    console.log('LWK WASM module loaded successfully');
    console.log('Network:', network.toString());
}

// Start the app
init();
