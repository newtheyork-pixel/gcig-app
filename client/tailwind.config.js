/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          50: '#E8EBF2',
          100: '#C6CDDD',
          200: '#8C99BB',
          400: '#3A4D78',
          500: '#253B66',
          DEFAULT: '#1B2A4A',
          600: '#1B2A4A',
          700: '#142038',
          800: '#0D1626',
        },
        gold: {
          100: '#F4E9C6',
          200: '#E8D391',
          300: '#E3CA7A',
          400: '#D6B863',
          DEFAULT: '#C9A84C',
          500: '#C9A84C',
          600: '#A8893B',
          700: '#9B7F2E',
          800: '#6F5A20',
        },
      },
      fontFamily: {
        sans: ['Geist', 'system-ui', '-apple-system', 'sans-serif'],
        // Serif stays on the public landing page and on long-form
        // prose (the Day in Review). App chrome is sans.
        serif: ['"Source Serif 4"', 'Georgia', 'serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(13, 22, 38, 0.04)',
      },
    },
  },
  plugins: [],
};
