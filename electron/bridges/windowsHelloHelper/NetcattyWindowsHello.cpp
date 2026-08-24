#include <windows.h>
#include <inspectable.h>
#include <roapi.h>
#include <winstring.h>

#include <iostream>
#include <string>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Security.Credentials.UI.h>

using winrt::Windows::Security::Credentials::UI::UserConsentVerificationResult;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifier;
using winrt::Windows::Security::Credentials::UI::UserConsentVerifierAvailability;

struct __declspec(uuid("39E050C3-4E74-441A-8DC0-B81104DF949C")) IUserConsentVerifierInterop : IInspectable {
  virtual HRESULT __stdcall RequestVerificationForWindowAsync(
    HWND appWindow,
    HSTRING message,
    REFIID riid,
    void** asyncOperation) = 0;
};

std::wstring jsonEscape(const std::wstring& value) {
  std::wstring escaped;
  for (wchar_t ch : value) {
    if (ch == L'\\' || ch == L'"') {
      escaped.push_back(L'\\');
      escaped.push_back(ch);
    } else if (ch == L'\n') {
      escaped += L"\\n";
    } else if (ch == L'\r') {
      escaped += L"\\r";
    } else {
      escaped.push_back(ch);
    }
  }
  return escaped;
}

const wchar_t* availabilityName(UserConsentVerifierAvailability value) {
  switch (value) {
    case UserConsentVerifierAvailability::Available: return L"Available";
    case UserConsentVerifierAvailability::DeviceNotPresent: return L"DeviceNotPresent";
    case UserConsentVerifierAvailability::NotConfiguredForUser: return L"NotConfiguredForUser";
    case UserConsentVerifierAvailability::DisabledByPolicy: return L"DisabledByPolicy";
    case UserConsentVerifierAvailability::DeviceBusy: return L"DeviceBusy";
    default: return L"Unknown";
  }
}

const wchar_t* verificationName(UserConsentVerificationResult value) {
  switch (value) {
    case UserConsentVerificationResult::Verified: return L"Verified";
    case UserConsentVerificationResult::DeviceNotPresent: return L"DeviceNotPresent";
    case UserConsentVerificationResult::NotConfiguredForUser: return L"NotConfiguredForUser";
    case UserConsentVerificationResult::DisabledByPolicy: return L"DisabledByPolicy";
    case UserConsentVerificationResult::DeviceBusy: return L"DeviceBusy";
    case UserConsentVerificationResult::RetriesExhausted: return L"RetriesExhausted";
    case UserConsentVerificationResult::Canceled: return L"Canceled";
    default: return L"Unknown";
  }
}

void printError(const std::wstring& error) {
  std::wcout << L"{\"ok\":false,\"error\":\"" << jsonEscape(error) << L"\"}\n";
}

HWND parseHwnd(const std::wstring& value) {
  try {
    unsigned long long raw = std::stoull(value, nullptr, 10);
    return reinterpret_cast<HWND>(static_cast<uintptr_t>(raw));
  } catch (...) {
    return nullptr;
  }
}

std::wstring argValue(int argc, wchar_t* argv[], const std::wstring& name) {
  for (int index = 2; index + 1 < argc; index += 1) {
    if (std::wstring(argv[index]) == name) return argv[index + 1];
  }
  return L"";
}

int wmain(int argc, wchar_t* argv[]) {
  if (argc < 2) {
    printError(L"missing-command");
    return 1;
  }

  try {
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const std::wstring command = argv[1];

    if (command == L"status") {
      const auto availability = UserConsentVerifier::CheckAvailabilityAsync().get();
      std::wcout
        << L"{\"supported\":true,\"available\":"
        << (availability == UserConsentVerifierAvailability::Available ? L"true" : L"false")
        << L",\"reason\":\"" << availabilityName(availability) << L"\"}\n";
      return 0;
    }

    if (command == L"verify") {
      const HWND hwnd = parseHwnd(argValue(argc, argv, L"--hwnd"));
      const std::wstring message = argValue(argc, argv, L"--message").empty()
        ? L"Unlock Netcatty"
        : argValue(argc, argv, L"--message");
      if (!hwnd) {
        printError(L"DeviceNotPresent");
        return 0;
      }

      auto interop = winrt::get_activation_factory<UserConsentVerifier, IUserConsentVerifierInterop>();
      winrt::Windows::Foundation::IAsyncOperation<UserConsentVerificationResult> operation{ nullptr };
      winrt::hstring hMessage(message);
      winrt::check_hresult(interop->RequestVerificationForWindowAsync(
        hwnd,
        static_cast<HSTRING>(winrt::get_abi(hMessage)),
        winrt::guid_of<winrt::Windows::Foundation::IAsyncOperation<UserConsentVerificationResult>>(),
        winrt::put_abi(operation)));

      const auto result = operation.get();
      if (result == UserConsentVerificationResult::Verified) {
        std::wcout << L"{\"ok\":true}\n";
      } else {
        std::wcout << L"{\"ok\":false,\"error\":\"" << verificationName(result) << L"\"}\n";
      }
      return 0;
    }

    printError(L"unknown-command");
    return 1;
  } catch (const winrt::hresult_error& err) {
    printError(err.message().c_str());
    return 1;
  } catch (const std::exception& err) {
    std::wcout << L"{\"ok\":false,\"error\":\"" << jsonEscape(winrt::to_hstring(err.what()).c_str()) << L"\"}\n";
    return 1;
  }
}
