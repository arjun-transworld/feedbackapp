# Does the manual Xcode steps from DEPLOY.md part 4b-4f, so the iOS app can be built
# on a cloud Mac (codemagic.yaml) without opening Xcode. Safe to run more than once.
# Run after `npx cap add ios` / `npx cap sync ios`:  ruby tools/ios-setup.rb
require 'fileutils'
require 'xcodeproj'

root = File.expand_path('..', __dir__)
app_dir = File.join(root, 'ios/App/App')
abort "ios/App not found. Run `npx cap add ios` first." unless Dir.exist?(app_dir)

project = Xcodeproj::Project.open(File.join(root, 'ios/App/App.xcodeproj'))
target = project.targets.find { |t| t.name == 'App' } or abort 'App target not found'
group = project.main_group['App'] or abort 'App group not found'

# 4b. Native files, added to the App target; AppDelegate replaced in place
%w[BackgroundUploader.swift BackgroundUploadPlugin.swift TokenProvider.swift MainViewController.swift].each do |f|
  FileUtils.cp(File.join(root, 'native-ios', f), app_dir)
  next if group.files.any? { |r| r.path == f }
  target.add_file_references([group.new_reference(f)])
end
FileUtils.cp(File.join(root, 'native-ios/replace/AppDelegate.swift'), File.join(app_dir, 'AppDelegate.swift'))

# 4c. Bridge View Controller → MainViewController (registers the plugin)
storyboard = File.join(app_dir, 'Base.lproj/Main.storyboard')
xml = File.read(storyboard)
unless xml.include?('customClass="MainViewController"')
  xml = xml.sub('customClass="CAPBridgeViewController" customModule="Capacitor"',
                'customClass="MainViewController" customModule="App" customModuleProvider="target"')
  abort 'Could not set MainViewController in Main.storyboard' unless xml.include?('customClass="MainViewController"')
  File.write(storyboard, xml)
end

# 4d. Keychain Sharing (com.microsoft.adalcache), so the background uploader can use the crew sign-in
File.write(File.join(app_dir, 'App.entitlements'), <<~XML)
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0">
  <dict>
    <key>keychain-access-groups</key>
    <array>
      <string>$(AppIdentifierPrefix)com.microsoft.adalcache</string>
    </array>
  </dict>
  </plist>
XML
group.new_reference('App.entitlements') unless group.files.any? { |r| r.path == 'App.entitlements' }

# 4f. Version and build number
target.build_configurations.each do |config|
  config.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements'
  config.build_settings['MARKETING_VERSION'] = ENV['APP_VERSION'] || '1.0.0'
  config.build_settings['CURRENT_PROJECT_VERSION'] = ENV['BUILD_NUMBER'] || '1'
end
project.save

# 4e. Microsoft sign-in settings in Info.plist (+ display name, export compliance)
plist_path = File.join(app_dir, 'Info.plist')
plist = Xcodeproj::Plist.read_from_path(plist_path)
scheme = 'msauth.$(PRODUCT_BUNDLE_IDENTIFIER)'
types = (plist['CFBundleURLTypes'] ||= [])
types << { 'CFBundleURLSchemes' => [scheme] } unless types.any? { |t| Array(t['CFBundleURLSchemes']).include?(scheme) }
queries = (plist['LSApplicationQueriesSchemes'] ||= [])
%w[msauthv2 msauthv3].each { |s| queries << s unless queries.include?(s) }
plist['CFBundleDisplayName'] = 'Private Skies Feedback'
plist['ITSAppUsesNonExemptEncryption'] = false
Xcodeproj::Plist.write_to_path(plist, plist_path)

puts 'iOS project set up: native files, MainViewController, Keychain Sharing, Info.plist, version.'
